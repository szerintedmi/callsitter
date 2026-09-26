import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../src/web/client/public.ts", import.meta.url), "utf8"),
);

/** Runs the page script against fake DOM, Web Audio, WebRTC and timers. */
function page() {
  const element = () => ({ hidden: false, style: {} as Record<string, string>, textContent: "", onclick: undefined as undefined | (() => void) });
  const me = element(), it = element();
  const elements: Record<string, any> = Object.fromEntries(
    ["cta", "go", "end", "orb", "msg", "remote", "jev", "needle", "stage"].map((id) => [id, element()]),
  );
  elements.orb.querySelector = (selector: string) => (selector === ".me" ? me : it);
  elements.remote.paused = true;
  elements.remote.play = async () => { elements.remote.paused = false; };
  const body = { className: "idle", dataset: {} };

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
    createMediaStreamSource: (s: { agent?: boolean }) => ({ connect: (a: { agent?: boolean }) => { a.agent = s.agent; } }),
    createAnalyser: () => {
      const a: { agent?: boolean; fftSize: number; getFloatTimeDomainData(b: Float32Array): void } = {
        fftSize: 512, getFloatTimeDomainData: (b) => b.fill(a.agent ? t.amplitude : 0),
      };
      return a;
    },
  };
  const mic = { getTracks: () => [{ stop() {} }] };
  const agent = { agent: true };
  let pc: any;
  let answered: () => void = () => {};
  runInNewContext(source, {
    document: { body, getElementById: (id: string) => elements[id] },
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
    fetch: async () => ({ ok: true, json: async () => ({ callId: "test", sdp: "answer" }) }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {},
    setTimeout: (run: () => void, ms: number) => (timeouts.set(nextTimer, { run, ms }), nextTimer++),
    clearTimeout: (id: number) => timeouts.delete(id),
    setInterval: (run: () => void, ms: number) => (intervals.set(nextTimer, { run, ms }), nextTimer++),
    clearInterval: (id: number) => intervals.delete(id),
    DOMException,
  });

  return {
    body, elements, audio, t, intervals,
    get pc() { return pc; },
    /** Clicks "Scam me" and waits until the answer SDP is applied. */
    async dial() {
      const done = new Promise<void>((resolve) => (answered = resolve));
      elements.go.onclick();
      await done;
    },
    connect() {
      pc.ontrack({ streams: [agent] });
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

test("stays connecting, ringing, through silent WebRTC startup; goes live once the greeting plays", async () => {
  const p = page();
  await p.dial();
  expect(p.body.className).toBe("connecting");
  expect(p.t.tonesStarted).toBe(2);
  expect(p.intervals.size).toBe(2); // ring + greeting poll

  p.connect();
  p.poll();
  expect(p.body.className).toBe("connecting");

  p.t.amplitude = 0.1;
  p.elements.remote.paused = true;
  p.poll();
  expect(p.body.className).toBe("connecting");
  p.elements.remote.paused = false;
  p.audio.state = "suspended";
  p.poll();
  expect(p.body.className).toBe("connecting");
  p.audio.state = "running";
  p.poll();
  expect(p.body.className).toBe("live");
  expect(p.elements.jev.hidden).toBe(false);
  expect(p.t.tonesStopped).toBe(2);
  expect(p.intervals.size).toBe(0);

  p.elements.end.onclick();
  expect(p.body.className).toBe("idle");
  expect(p.t.tonesStopped).toBe(2);
});

test("goes live anyway when the page can't hear the greeting", async () => {
  const p = page();
  await p.dial();
  p.audio.state = "suspended";
  p.connect();
  p.poll();
  expect(p.body.className).toBe("connecting");
  p.fire(6000);
  expect(p.body.className).toBe("live");
  expect(p.t.tonesStopped).toBe(2);
  expect(p.intervals.size).toBe(0);
});

test("connecting is announced but not shown", async () => {
  const p = page();
  p.elements.go.onclick();
  expect(p.body.className).toBe("connecting");
  expect(p.elements.msg.textContent).toBe("Connecting…");
});

test("hanging up or failing while connecting stops the ringback", async () => {
  const p = page();
  await p.dial();
  p.elements.end.onclick();
  expect(p.body.className).toBe("idle");
  expect(p.t.tonesStopped).toBe(2);
  expect(p.intervals.size).toBe(0);

  await p.dial();
  p.pc.connectionState = "failed";
  p.pc.onconnectionstatechange();
  expect(p.body.className).toBe("idle");
  expect(p.t.tonesStopped).toBe(4);
  expect(p.intervals.size).toBe(0);
});
