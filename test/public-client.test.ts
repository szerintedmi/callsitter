import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The public page's call (src/web/client/phone.ts) against fake Web Audio, WebRTC and timers.
// It has no imports, so it runs as a plain script once its `export`s are dropped.
const source = new Bun.Transpiler({ loader: "ts" })
  .transformSync(readFileSync(new URL("../src/web/client/phone.ts", import.meta.url), "utf8"))
  .replace(/^export /gm, "");

function phone() {
  const t = { amplitude: 0, tonesStarted: 0, tonesStopped: 0 };
  const intervals = new Map<number, { run: () => void; ms: number }>();
  const timeouts = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const audio = {
    state: "running",
    currentTime: 0, destination: {},
    createGain: () => ({
      gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} },
      connect() {}, disconnect() {},
    }),
    createOscillator: () => ({
      frequency: { value: 0 }, connect() {}, disconnect() {},
      start() { t.tonesStarted++; }, stop() { t.tonesStopped++; },
    }),
    resume: async () => {}, close: async () => {},
    createMediaStreamSource: () => ({ connect() {} }),
    createAnalyser: () => ({ fftSize: 512, getFloatTimeDomainData: (b: Float32Array) => b.fill(t.amplitude) }),
  };
  const mic = { getTracks: () => [{ stop() {} }] };
  const remote = { paused: true, srcObject: null as unknown, play: async () => { remote.paused = false; } };
  const posts: { path: string; body: any }[] = [];
  const ends: { live: boolean; text: string; callId: string | null }[] = [];
  let lives = 0;
  let pc: any;
  let answered: () => void = () => {};
  const ctx: Record<string, any> = {
    navigator: { mediaDevices: { getUserMedia: async () => mic }, sendBeacon() {} },
    AudioContext: function () { return audio; },
    RTCPeerConnection: function () {
      return (pc = {
        connectionState: "new", addTrack() {}, createDataChannel: () => ({}),
        createOffer: async () => ({ sdp: "offer" }), setLocalDescription: async () => {},
        setRemoteDescription: async () => answered(), close() {},
      });
    },
    EventSource: class { addEventListener() {} close() {} },
    fetch: async (url: string, init: { body: string }) => {
      posts.push({ path: url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ callId: "test", sdp: "answer", elapsedMs: 1500 }) };
    },
    setTimeout: (run: () => void, ms: number) => (timeouts.set(nextTimer, { run, ms }), nextTimer++),
    clearTimeout: (id: number) => timeouts.delete(id),
    setInterval: (run: () => void, ms: number) => (intervals.set(nextTimer, { run, ms }), nextTimer++),
    clearInterval: (id: number) => intervals.delete(id),
    DOMException, Date, JSON, Math, Float32Array, String, Promise,
  };
  runInNewContext(source, ctx);

  let call: any;
  return {
    t, intervals, audio, remote, posts, ends,
    get lives() { return lives; },
    get pc() { return pc; },
    get call() { return call; },
    /** Starts a call without waiting for the answer. */
    start() {
      call = ctx.dial({
        base: "/", game: { game: "scam", goal: "safe_account", player: "KEV" }, remote,
        onLive: () => lives++, onState() {}, onEnd: (e: (typeof ends)[number]) => ends.push(e),
      });
    },
    /** Starts a call and waits until the answer SDP is applied. */
    async dial() {
      const done = new Promise<void>((resolve) => (answered = resolve));
      this.start();
      await done;
    },
    connect() {
      pc.ontrack({ streams: [{}] });
      pc.connectionState = "connected";
      pc.onconnectionstatechange();
    },
    /** Runs the greeting poll once. */
    poll() {
      for (const i of intervals.values()) if (i.ms < 1000) i.run();
    },
    fire(ms: number) {
      for (const [id, i] of timeouts) if (i.ms === ms) (timeouts.delete(id), i.run());
    },
  };
}

test("sends the game with the offer and sets its clock by the server's", async () => {
  const p = phone();
  const before = Date.now();
  await p.dial();
  expect(p.posts[0]).toEqual({ path: "/call", body: { sdp: "offer", game: "scam", goal: "safe_account", player: "KEV" } });
  expect(p.call.id).toBe("test");
  // The server's call started 1.5 s before its answer.
  expect(p.call.t0).toBeLessThanOrEqual(before - 1500 + 50);
});

test("rings through silent WebRTC startup; goes live once the greeting plays", async () => {
  const p = phone();
  await p.dial();
  expect(p.t.tonesStarted).toBe(2);
  expect(p.intervals.size).toBe(2); // ring + greeting poll

  p.connect();
  p.poll();
  expect(p.lives).toBe(0);

  p.t.amplitude = 0.1;
  p.remote.paused = true;
  p.poll();
  expect(p.lives).toBe(0);
  p.remote.paused = false;
  p.audio.state = "suspended";
  p.poll();
  expect(p.lives).toBe(0);
  p.audio.state = "running";
  p.poll();
  expect(p.lives).toBe(1);
  expect(p.t.tonesStopped).toBe(2);
  expect(p.intervals.size).toBe(0);

  p.call.hangUp();
  expect(p.ends).toEqual([{ live: true, text: "", callId: "test" }]);
  expect(p.t.tonesStopped).toBe(2);
});

test("goes live anyway when the page can't hear the greeting", async () => {
  const p = phone();
  await p.dial();
  p.audio.state = "suspended";
  p.connect();
  p.poll();
  expect(p.lives).toBe(0);
  p.fire(6000);
  expect(p.lives).toBe(1);
  expect(p.t.tonesStopped).toBe(2);
  expect(p.intervals.size).toBe(0);
});

test("hanging up or failing while connecting stops the ringback, and never went live", async () => {
  const p = phone();
  await p.dial();
  p.call.hangUp();
  expect(p.ends.at(-1)).toEqual({ live: false, text: "", callId: "test" });
  expect(p.t.tonesStopped).toBe(2);
  expect(p.intervals.size).toBe(0);

  await p.dial();
  p.pc.connectionState = "failed";
  p.pc.onconnectionstatechange();
  expect(p.ends.at(-1)).toEqual({ live: false, text: "Call ended.", callId: "test" });
  expect(p.t.tonesStopped).toBe(4);
  expect(p.intervals.size).toBe(0);
});
