import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../src/adapters/storage/fs-blob";
import { FsRecordingStore } from "../src/adapters/storage/fs-recording";
import { LameCompressor } from "../src/adapters/storage/lame-compressor";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { CallManager } from "../src/core/call-manager";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import type { RecordingCompressor, RecordingStore } from "../src/core/ports";
import type { CallEvent } from "../src/core/types";
import { wavHeader } from "../src/core/wav";
import { loadRepoConfig, scripted } from "./helpers";

/** Opens files for real, but audio writes (past the header) land at most `max` bytes, or fail. */
const shortWrites = (next: () => { max?: number; fail?: boolean }) => async (path: string, flags: string) => {
  const fh = await open(path, flags);
  const write = fh.write.bind(fh) as (b: Uint8Array, o: number, l: number, p: number) => Promise<{ bytesWritten: number }>;
  Object.assign(fh, {
    write: (b: Uint8Array, o: number, l: number, p: number) => {
      if (p < 44) return write(b, o, l, p);
      const w = next();
      if (w.fail) return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      return write(b, o, Math.min(l, w.max ?? l), p);
    },
  });
  return fh;
};
const tmp = () => mkdtempSync(join(tmpdir(), "callsitter-rec-"));
const u32 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint32(off, true);
const frames = (n: number, fill: number) => new Uint8Array(n * 4).fill(fill);

describe("FsRecordingStore", () => {
  test("writes a .part as it goes; finish() patches the sizes and renames it", async () => {
    const root = tmp();
    const sink = new FsRecordingStore(root).open("recordings/c1.wav", { rate: 24000, channels: 2 });
    await sink.append(frames(3, 1));
    const part = readFileSync(join(root, "recordings/c1.wav.part"));
    expect(part.length).toBe(44 + 12); // on disk already, header sizes still placeholders
    expect(u32(part, 40)).toBe(0);
    await sink.append(frames(2, 2));
    expect(await sink.finish()).toBe("recordings/c1.wav");
    expect(existsSync(join(root, "recordings/c1.wav.part"))).toBe(false);
    const wav = readFileSync(join(root, "recordings/c1.wav"));
    expect(wav.length).toBe(44 + 20);
    expect(u32(wav, 4)).toBe(36 + 20);
    expect(u32(wav, 40)).toBe(20);
    expect(u32(wav, 24)).toBe(24000);
    expect([...wav.subarray(44)]).toEqual([...frames(3, 1), ...frames(2, 2)]);
  });

  test("a recording that never started leaves no file; one finished empty is a valid WAV", async () => {
    const root = tmp();
    const store = new FsRecordingStore(root);
    store.open("recordings/unused.wav", { rate: 16000, channels: 2 });
    await store.open("recordings/empty.wav", { rate: 16000, channels: 2 }).finish();
    expect(existsSync(join(root, "recordings/unused.wav.part"))).toBe(false);
    expect(readFileSync(join(root, "recordings/empty.wav")).length).toBe(44);
  });

  test("recover() finishes crashed .part files, dropping a trailing partial frame", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    // header with placeholder sizes, 3 whole stereo frames and half of one
    writeFileSync(join(root, "recordings/c2.wav.part"), new Uint8Array([...wavHeader(24000, 2, 0), ...frames(3, 7), 9, 9]));
    writeFileSync(join(root, "recordings/c3.wav.part"), new Uint8Array(10)); // crashed before its header
    writeFileSync(join(root, "recordings/done.wav"), new Uint8Array([...wavHeader(24000, 2, 4), ...frames(1, 1)]));
    const keys = await new FsRecordingStore(root).recover();
    expect(keys).toEqual(["recordings/c2.wav"]);
    const wav = readFileSync(join(root, "recordings/c2.wav"));
    expect(wav.length).toBe(44 + 12);
    expect(u32(wav, 4)).toBe(36 + 12);
    expect(u32(wav, 40)).toBe(12);
    expect([...wav.subarray(44)]).toEqual([...frames(3, 7)]);
    expect(existsSync(join(root, "recordings/c2.wav.part"))).toBe(false);
    expect(existsSync(join(root, "recordings/c3.wav.part"))).toBe(false);
    expect(await new FsRecordingStore(tmp()).recover()).toEqual([]); // no recordings dir yet
  });

  test("recover() leaves files that aren't WAVs alone (an MP3 being encoded)", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    const mp3 = new Uint8Array([0xff, 0xf3, 0x64, 0xc4, ...frames(8, 3)]);
    writeFileSync(join(root, "recordings/c5.mp3.part"), mp3);
    writeFileSync(join(root, "recordings/c5.mp3.encoding"), mp3);
    expect(await new FsRecordingStore(root).recover()).toEqual([]);
    expect([...readFileSync(join(root, "recordings/c5.mp3.part"))]).toEqual([...mp3]);
    expect([...readFileSync(join(root, "recordings/c5.mp3.encoding"))]).toEqual([...mp3]);
    expect(existsSync(join(root, "recordings/c5.mp3"))).toBe(false);
  });

  test("recover() never replaces a finished recording of the same name", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    const done = new Uint8Array([...wavHeader(24000, 2, 4), ...frames(1, 1)]);
    writeFileSync(join(root, "recordings/c4.wav"), done);
    writeFileSync(join(root, "recordings/c4.wav.part"), new Uint8Array([...wavHeader(24000, 2, 0), ...frames(2, 5)]));
    expect(await new FsRecordingStore(root).recover()).toEqual(["recordings/c4.recovered.wav"]);
    expect([...readFileSync(join(root, "recordings/c4.wav"))]).toEqual([...done]);
    expect(u32(readFileSync(join(root, "recordings/c4.recovered.wav")), 40)).toBe(8);
  });

  test("a short write goes on from where it stopped", async () => {
    const root = tmp();
    // Every audio write lands at most 6 bytes (1.5 frames).
    const sink = new FsRecordingStore(root, "recordings", shortWrites(() => ({ max: 6 }))).open("recordings/c5.wav", { rate: 24000, channels: 2 });
    await sink.append(frames(2, 3));
    await sink.append(frames(1, 4));
    await sink.finish();
    const wav = readFileSync(join(root, "recordings/c5.wav"));
    expect(u32(wav, 40)).toBe(12);
    expect([...wav.subarray(44)]).toEqual([...frames(2, 3), ...frames(1, 4)]);
  });

  test("a write failing after a short write keeps every whole frame that landed", async () => {
    const root = tmp();
    // The first audio write lands 10 of 12 bytes, the next one fails (disk full).
    let n = 0;
    const store = new FsRecordingStore(root, "recordings", shortWrites(() => (++n === 1 ? { max: 10 } : { fail: true })));
    const sink = store.open("recordings/c6.wav", { rate: 24000, channels: 2 });
    await expect(sink.append(frames(3, 5))).rejects.toThrow("ENOSPC");
    await sink.finish();
    const wav = readFileSync(join(root, "recordings/c6.wav"));
    // 2 whole frames (8 bytes); the half frame after them is cut.
    expect(u32(wav, 40)).toBe(8);
    expect(u32(wav, 4)).toBe(36 + 8);
    expect([...wav.subarray(44)]).toEqual([...frames(2, 5)]);
  });
});

async function rig(recordings: RecordingStore, compressor?: RecordingCompressor) {
  const config = await loadRepoConfig();
  const repo = new SqliteRepo(openSqlite(":memory:"));
  const bus = new MemoryEventBus();
  const persistence = attachPersistence(bus, repo);
  const events: CallEvent[] = [];
  bus.subscribe((ev) => void events.push(ev));
  const manager = new CallManager({
    config: () => config,
    voice: { connect: async () => ({ sendAudio() {}, append() {}, async close() {} }) },
    classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
    agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
    bus,
    telephony: { hangup: async () => {} },
    clock: { now: () => Date.now() },
    repo,
    blobs: { put: async (k) => k, get: async () => null },
    recordings,
    compressor,
  });
  await manager.registerIncoming({ callId: "c1", callControlId: "cc1", from: "+441", to: "+442", channel: "phone" });
  return { manager, repo, persistence, events, config };
}

describe("CallManager recordings", () => {
  test("a failed write stops the recording with a note; what was written is still stored", async () => {
    const appended: number[] = [];
    let n = 0;
    const r = await rig({
      open: () => ({
        append: async (pcm) => {
          if (++n === 2) throw new Error("disk full");
          appended.push(pcm.length);
        },
        finish: async () => "recordings/c1.wav",
      }),
    });
    const w = r.manager.openRecording("c1", 24000, 2);
    w.append(frames(1, 1));
    w.append(frames(2, 1));
    w.append(frames(3, 1));
    expect(await w.finish()).toBe("recordings/c1.wav");
    expect(appended).toEqual([4]);
    expect(r.events.some((e) => e.type === "recording.failed" && e.reason === "recording stopped: writing it failed")).toBe(true);
    await r.persistence.flush();
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.wav");
  });

  test("storage falling 30 s behind stops the recording, so queued audio can't fill memory", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const appended: number[] = [];
    const r = await rig({
      open: () => ({
        append: async (pcm) => {
          await slow;
          appended.push(pcm.length);
        },
        finish: async () => "recordings/c1.wav",
      }),
    });
    const w = r.manager.openRecording("c1", 1000, 2);
    // 5 s blocks at 1 kHz stereo (20 kB each): 6 fit in 30 s, the 7th stops the recording.
    const block = new Uint8Array(5 * 1000 * 4);
    // The first block is being written (storage stalls on it) while the rest queue behind it.
    w.append(block);
    await Bun.sleep(0);
    for (let i = 1; i < 12; i++) w.append(block);
    await Bun.sleep(0);
    expect(r.events.filter((e) => e.type === "recording.failed" && e.reason === "recording stopped: storage fell over 30 s behind")).toHaveLength(1);
    release();
    expect(await w.finish()).toBe("recordings/c1.wav");
    // Only the block in flight lands; the queued ones are dropped.
    expect(appended).toEqual([block.length]);
  });

  test("stopAll waits for a recording to be stored", async () => {
    let release!: () => void;
    const r = await rig({
      open: () => ({ append: async () => {}, finish: () => new Promise((res) => (release = () => res("recordings/c1.wav"))) }),
    });
    const w = r.manager.openRecording("c1", 24000, 2);
    w.append(frames(1, 1));
    void w.finish();
    let done = false;
    const all = r.manager.stopAll("deploy").then(() => (done = true));
    await Bun.sleep(10);
    expect(done).toBe(false);
    release();
    await all;
    expect(r.events.some((e) => e.type === "recording")).toBe(true);
  });

  test("recoverRecordings: a crashed call's .part becomes its recording", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    const r = await rig(new FsRecordingStore(root));
    writeFileSync(join(root, "recordings/c1.wav.part"), new Uint8Array([...wavHeader(24000, 2, 0), ...frames(2, 3)]));
    writeFileSync(join(root, "recordings/gone.wav.part"), new Uint8Array([...wavHeader(24000, 2, 0), ...frames(2, 3)]));
    await r.manager.recoverRecordings();
    await r.persistence.flush();
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.wav");
    expect(existsSync(join(root, "recordings/gone.wav"))).toBe(true); // kept, though no call has it
  });
});

/** A compressor that logs what it's asked to do; `fail` makes compress() reject, `gate` holds it. */
function fakeCompressor(opts: { wavs?: string[]; fail?: boolean; gate?: Promise<void> } = {}) {
  const ops: string[] = [];
  const compressor: RecordingCompressor = {
    async compress(key, { kbps }) {
      ops.push(`compress ${key} ${kbps}`);
      await opts.gate;
      await Bun.sleep(1); // encoding takes a while: the `recording` event is stored by then
      if (opts.fail) throw new Error("lame exited with 1");
      return key.replace(/\.wav$/, ".mp3");
    },
    async remove(key) {
      ops.push(`remove ${key}`);
    },
    listWav: async () => opts.wavs ?? [],
  };
  return { compressor, ops };
}

const streamed = (): RecordingStore => ({ open: (key) => ({ append: async () => {}, finish: async () => key }) });

describe("CallManager recording compression", () => {
  for (const deleteWav of [false, true]) {
    test(`after the call: the WAV is compressed and the call's recording moves to the MP3 (delete_wav_after_mp3: ${deleteWav})`, async () => {
      const { compressor, ops } = fakeCompressor();
      const r = await rig(streamed(), compressor);
      r.config.connection.recordings.delete_wav_after_mp3 = deleteWav;
      const w = r.manager.openRecording("c1", 24000, 2);
      w.append(frames(1, 1));
      expect(await w.finish()).toBe("recordings/c1.wav");
      await r.manager.compressions();
      // The WAV goes only after the call's recording is the MP3.
      expect(ops).toEqual(["compress recordings/c1.wav 56", ...(deleteWav ? ["remove recordings/c1.wav"] : [])]);
      await r.persistence.flush();
      expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.mp3");
      // One `recording` event (the WAV's): the swap only updates the call row.
      expect(r.events.filter((e) => e.type === "recording")).toHaveLength(1);
    });
  }

  test("stopAll doesn't wait for compression", async () => {
    let release!: () => void;
    const { compressor, ops } = fakeCompressor({ gate: new Promise((res) => (release = res)) });
    const r = await rig(streamed(), compressor);
    const w = r.manager.openRecording("c1", 24000, 2);
    w.append(frames(1, 1));
    await w.finish();
    await r.manager.stopAll("deploy");
    expect(ops).toEqual(["compress recordings/c1.wav 56"]);
    release();
    await r.manager.compressions();
  });

  test("a failed encode keeps the WAV as the call's recording and doesn't touch the call", async () => {
    const { compressor, ops } = fakeCompressor({ fail: true });
    const r = await rig(streamed(), compressor);
    const w = r.manager.openRecording("c1", 24000, 2);
    w.append(frames(1, 1));
    await w.finish();
    await r.manager.compressions();
    expect(ops).toEqual(["compress recordings/c1.wav 56"]);
    await r.persistence.flush();
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.wav");
    expect(r.events.some((e) => e.type === "recording.failed")).toBe(false);
  });

  test("the WAV stays if the call's recording is another one by the time it's encoded", async () => {
    const { compressor, ops } = fakeCompressor();
    const r = await rig(streamed(), compressor);
    await r.repo.updateCall("c1", { recordingPath: "recordings/c1.recovered.wav" });
    // Telnyx WAVs are compressed too.
    await r.manager.saveRecording("c1", new ArrayBuffer(4), "wav");
    await r.persistence.flush();
    await r.repo.updateCall("c1", { recordingPath: "recordings/other.mp3" });
    await r.manager.compressions();
    expect(ops).toEqual(["compress recordings/c1.wav 56"]);
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/other.mp3");
  });

  test("compressLeftovers queues only WAVs that are still their call's recording, once each", async () => {
    const { compressor, ops } = fakeCompressor({ wavs: ["recordings/c1.wav", "recordings/c1.recovered.wav", "recordings/gone.wav"] });
    const r = await rig(streamed(), compressor);
    r.config.connection.recordings.delete_wav_after_mp3 = false;
    await r.repo.updateCall("c1", { recordingPath: "recordings/c1.wav" });
    await r.manager.compressLeftovers();
    await r.manager.compressLeftovers(); // already queued: not again
    await r.manager.compressions();
    expect(ops).toEqual(["compress recordings/c1.wav 56"]);
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.mp3");
  });

  for (const deleteWav of [false, true]) {
    test(`compressLeftovers doesn't re-encode a WAV whose MP3 is the call's recording (delete_wav_after_mp3: ${deleteWav})`, async () => {
      const { compressor, ops } = fakeCompressor({ wavs: ["recordings/c1.wav"] });
      const r = await rig(streamed(), compressor);
      r.config.connection.recordings.delete_wav_after_mp3 = deleteWav;
      await r.repo.updateCall("c1", { recordingPath: "recordings/c1.mp3" });
      await r.manager.compressLeftovers();
      await r.manager.compressions();
      expect(ops).toEqual(deleteWav ? ["remove recordings/c1.wav"] : []);
      expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.mp3");
    });
  }

  test("a recovered recording is compressed after it becomes the call's", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    const { compressor, ops } = fakeCompressor();
    const r = await rig(new FsRecordingStore(root), compressor);
    r.config.connection.recordings.delete_wav_after_mp3 = false;
    writeFileSync(join(root, "recordings/c1.wav.part"), new Uint8Array([...wavHeader(24000, 2, 0), ...frames(2, 3)]));
    await r.manager.recoverRecordings();
    await r.manager.compressions();
    expect(ops).toEqual(["compress recordings/c1.wav 56"]);
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.mp3");
  });

  test("connection.yaml recordings.mp3: false keeps the WAVs", async () => {
    const { compressor, ops } = fakeCompressor({ wavs: ["recordings/c1.wav"] });
    const r = await rig(streamed(), compressor);
    r.config.connection.recordings.mp3 = false;
    await r.repo.updateCall("c1", { recordingPath: "recordings/c1.wav" });
    const w = r.manager.openRecording("c1", 24000, 2);
    await w.finish();
    await r.manager.compressLeftovers();
    await r.manager.compressions();
    expect(ops).toEqual([]);
  });
});

describe.skipIf(!Bun.which("lame"))("LameCompressor (needs lame installed)", () => {
  test("encodes a WAV to an MP3 next to it, lists and removes WAVs", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    // 0.5 s of a 24 kHz stereo square-ish wave
    const pcm = new Int16Array(12000 * 2).map((_, i) => ((i >> 6) & 1 ? 8000 : -8000));
    writeFileSync(join(root, "recordings/c1.wav"), new Uint8Array([...wavHeader(24000, 2, pcm.byteLength), ...new Uint8Array(pcm.buffer)]));
    writeFileSync(join(root, "recordings/c2.wav.part"), new Uint8Array(44));
    const c = new LameCompressor(root);
    expect(await c.listWav()).toEqual(["recordings/c1.wav"]);
    expect(await c.compress("recordings/c1.wav", { kbps: 56 })).toBe("recordings/c1.mp3");
    const mp3 = readFileSync(join(root, "recordings/c1.mp3"));
    expect(mp3.length).toBeGreaterThan(1000);
    expect(mp3.length).toBeLessThan(pcm.byteLength / 8);
    expect(existsSync(join(root, "recordings/c1.mp3.encoding"))).toBe(false);
    // The blob store serves it as MP3.
    expect((await new FsBlobStore(root).get("recordings/c1.mp3"))?.contentType).toStartWith("audio/mpeg");
    await c.remove("recordings/c1.wav");
    expect(await c.listWav()).toEqual([]);
  });

  test("a WAV lame can't read rejects and leaves no MP3", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    writeFileSync(join(root, "recordings/bad.wav"), "not a wav at all");
    const c = new LameCompressor(root);
    await expect(c.compress("recordings/bad.wav", { kbps: 56 })).rejects.toThrow("lame exited");
    expect(existsSync(join(root, "recordings/bad.mp3"))).toBe(false);
    expect(existsSync(join(root, "recordings/bad.mp3.encoding"))).toBe(false);
  });

  test("a restart during an encode: recovery leaves the MP3 alone and the next encode replaces it", async () => {
    const root = tmp();
    mkdirSync(join(root, "recordings"));
    const pcm = new Int16Array(12000 * 2).map((_, i) => ((i >> 6) & 1 ? 8000 : -8000));
    writeFileSync(join(root, "recordings/c1.wav"), new Uint8Array([...wavHeader(24000, 2, pcm.byteLength), ...new Uint8Array(pcm.buffer)]));
    const c = new LameCompressor(root);
    await c.compress("recordings/c1.wav", { kbps: 56 });
    // Interrupted: half the encoder's output, under its temporary name.
    const mp3 = readFileSync(join(root, "recordings/c1.mp3"));
    rmSync(join(root, "recordings/c1.mp3"));
    const cut = mp3.subarray(0, mp3.length >> 1);
    writeFileSync(join(root, "recordings/c1.mp3.encoding"), cut);
    // Startup: WAV recovery doesn't touch it (it would have put a WAV header over the MP3)...
    expect(await new FsRecordingStore(root).recover()).toEqual([]);
    expect([...readFileSync(join(root, "recordings/c1.mp3.encoding"))]).toEqual([...cut]);
    expect(existsSync(join(root, "recordings/c1.mp3"))).toBe(false);
    // ...and the sweep's encode starts over.
    expect(await c.compress("recordings/c1.wav", { kbps: 56 })).toBe("recordings/c1.mp3");
    expect([...readFileSync(join(root, "recordings/c1.mp3"))]).toEqual([...mp3]);
    expect(existsSync(join(root, "recordings/c1.mp3.encoding"))).toBe(false);
  });
});
