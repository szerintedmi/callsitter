import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsRecordingStore } from "../src/adapters/storage/fs-recording";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { CallManager } from "../src/core/call-manager";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import type { RecordingStore } from "../src/core/ports";
import type { CallEvent } from "../src/core/types";
import { wavHeader } from "../src/core/wav";
import { loadRepoConfig, scripted } from "./helpers";

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
    const sink = new FsRecordingStore(root).open("recordings/c5.wav", { rate: 24000, channels: 2 });
    await sink.append(frames(2, 3));
    await sink.append(frames(1, 4));
    await sink.finish();
    const wav = readFileSync(join(root, "recordings/c5.wav"));
    expect([...wav.subarray(44)]).toEqual([...frames(2, 3), ...frames(1, 4)]);
  });
});

async function rig(recordings: RecordingStore) {
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
  });
  await manager.registerIncoming({ callId: "c1", callControlId: "cc1", from: "+441", to: "+442", channel: "phone" });
  return { manager, repo, persistence, events };
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
    expect(r.events.some((e) => e.type === "note" && e.level === "warn" && e.message.includes("recording stopped"))).toBe(true);
    await r.persistence.flush();
    expect((await r.repo.getCall("c1"))?.recordingPath).toBe("recordings/c1.wav");
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
