import { describe, expect, test } from "bun:test";
import { b64encode } from "../src/core/audio";
import type { AppConfig } from "../src/core/config";
import { GreetingCache, recordGreeting } from "../src/core/greeting";
import type { BlobStore, VoiceAgent } from "../src/core/ports";
import { loadRepoConfig } from "./helpers";

/** 20 ms of loud audio, tagged with `n` in its first byte. */
function speech(n: number, codec: string): Uint8Array {
  const a = new Uint8Array(codec === "l16" ? 640 : 160).fill(codec === "l16" ? 0x40 : 0x12);
  a[0] = n;
  return a;
}

function memoryBlobs(): BlobStore & { keys: () => string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    keys: () => [...m.keys()],
    async put(key, data) {
      m.set(key, new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)));
      return key;
    },
    async get(key) {
      const v = m.get(key);
      return v ? { body: new Blob([v]), contentType: "application/octet-stream" } : null;
    },
  };
}

describe("greeting recording", () => {
  test("records Live's greeting from its first speech to the end, plus a short tail; feeds silence meanwhile", async () => {
    const cfg = await loadRepoConfig();
    let fed = 0;
    let closed = false;
    const voice: VoiceAgent = {
      async connect(_o, h) {
        // Live sends faint noise (not digital silence), says "Hello?", then pads with silence.
        const hiss = b64encode(new Uint8Array(160).fill(0xd4)); // ~-62 dBFS
        const pad = b64encode(new Uint8Array(160).fill(0xd5));
        const word = b64encode(new Uint8Array(160).fill(0x12));
        for (let i = 0; i < 10; i++) h.onAudio(hiss); // 200 ms
        h.onAudio(word);
        h.onAudio(pad); // a pause inside the greeting is kept
        h.onAudio(word);
        h.onAudio(pad);
        return { sendAudio: () => void fed++, append() {}, close: async () => void (closed = true) };
      },
    };
    const audio = await recordGreeting(voice, cfg.live, "pcma");
    expect(audio.length).toBe(100 * 8 + 3 * 160 + 100 * 8); // 100 ms lead-in, word, pause, word, 100 ms tail
    expect(audio[0]).toBe(0xd4);
    expect(audio[800]).toBe(0x12);
    expect(audio.at(-1)).toBe(0xd5);
    expect(fed).toBeGreaterThan(0);
    expect(closed).toBe(true);
  });

  test("fails when Live never speaks", async () => {
    const cfg = await loadRepoConfig();
    const voice: VoiceAgent = {
      connect: async () => ({ sendAudio() {}, append() {}, async close() {} }),
    };
    await expect(recordGreeting(voice, cfg.live, "l16", { timeoutMs: 300 })).rejects.toThrow("didn't say the greeting");
  });
});

describe("greeting cache", () => {
  async function rig(blobs = memoryBlobs(), quiet = false) {
    let cfg: AppConfig = await loadRepoConfig();
    cfg.connection.media_stream.codec = "pcma";
    cfg.live.voice = "marin"; // independent of the voice chosen in config/live.yaml
    const recorded: string[] = [];
    const cache = new GreetingCache({
      voice: {} as VoiceAgent,
      blobs,
      config: () => cfg,
      record: async (_v, live, codec) => {
        recorded.push(`${live.voice}/${codec}`);
        return quiet ? new Uint8Array(160).fill(0xd4) : speech(recorded.length, codec);
      },
      log: () => {},
    });
    return { cache, blobs, recorded, cfg: () => cfg, setCfg: (c: AppConfig) => (cfg = c) };
  }

  test("records the phone codec and l16 once, then serves them", async () => {
    const r = await rig();
    expect(r.cache.get("pcma")).toBeNull();
    await r.cache.refresh();
    await r.cache.refresh(); // nothing changed: no re-recording
    expect(r.recorded).toEqual(["marin/pcma", "marin/l16"]);
    expect(r.cache.get("pcma")?.[0]).toBe(1);
    expect(r.cache.get("l16")?.[0]).toBe(2);
    expect(r.blobs.keys()).toEqual([
      expect.stringMatching(/^greetings\/marin-pcma-[0-9a-f]{8}\.raw$/),
      expect.stringMatching(/^greetings\/marin-pcma-[0-9a-f]{8}\.wav$/), // to listen to
      expect.stringMatching(/^greetings\/marin-l16-.*\.raw$/),
      expect.stringMatching(/^greetings\/marin-l16-.*\.wav$/),
    ]);
  });

  test("a restart loads the stored recordings instead of re-recording", async () => {
    const first = await rig();
    await first.cache.refresh();
    const second = await rig(first.blobs);
    await second.cache.refresh();
    expect(second.recorded).toEqual([]);
    expect(second.cache.get("l16")?.[0]).toBe(2);
  });

  test("a prompt change doesn't re-record; switching back to an earlier voice reuses its recording", async () => {
    const r = await rig();
    await r.cache.refresh();
    const prompt = structuredClone(r.cfg());
    prompt.live.instructions += "\nStick to the point.";
    r.setCfg(prompt);
    await r.cache.refresh();
    expect(r.recorded).toHaveLength(2);
    const cedar = structuredClone(prompt);
    cedar.live.voice = "cedar";
    r.setCfg(cedar);
    await r.cache.refresh();
    r.setCfg(prompt); // back to marin
    await r.cache.refresh();
    expect(r.recorded).toEqual(["marin/pcma", "marin/l16", "cedar/pcma", "cedar/l16"]);
    expect(r.cache.get("pcma")?.[0]).toBe(1);
  });

  test("a voice or greeting change re-records; the old recording is never served for the new config", async () => {
    const r = await rig();
    await r.cache.refresh();
    const next = structuredClone(r.cfg());
    next.live.voice = "cedar";
    r.setCfg(next);
    expect(r.cache.get("pcma")).toBeNull(); // stale until re-recorded
    await r.cache.refresh();
    expect(r.recorded).toEqual(["marin/pcma", "marin/l16", "cedar/pcma", "cedar/l16"]);
    expect(r.cache.get("pcma")?.[0]).toBe(3);
  });

  test("a stored file without speech (e.g. only noise) is recorded again", async () => {
    const quiet = await rig(memoryBlobs(), true);
    await quiet.cache.refresh();
    const next = await rig(quiet.blobs);
    await next.cache.refresh();
    expect(next.recorded).toEqual(["marin/pcma", "marin/l16"]);
    expect(next.cache.get("pcma")?.[0]).toBe(1);
  });

  test("a failed recording leaves calls on the ask-Live path", async () => {
    const cfg = await loadRepoConfig();
    const cache = new GreetingCache({
      voice: {} as VoiceAgent,
      blobs: memoryBlobs(),
      config: () => cfg,
      record: async () => {
        throw new Error("Live down");
      },
      log: () => {},
    });
    await cache.refresh();
    expect(cache.get("l16")).toBeNull();
  });
});

