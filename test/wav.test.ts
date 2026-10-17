import { describe, expect, test } from "bun:test";
import { toPcm16 } from "../src/core/audio";
import { encodeWav, StereoRecorder, type StereoRecorderOptions, WavBuffer } from "../src/core/wav";

const le = (...samples: number[]) => {
  const b = new Uint8Array(samples.length * 2);
  samples.forEach((s, i) => new DataView(b.buffer).setInt16(i * 2, s, true));
  return b;
};
const samples = (wav: ArrayBuffer, channel: number, channels = 2) => {
  const v = new DataView(wav);
  const n = (wav.byteLength - 44) / 2 / channels;
  return Array.from({ length: n }, (_, i) => v.getInt16(44 + (i * channels + channel) * 2, true));
};

/** a recorder writing to memory; wav() finishes it */
const rec = (rate: number, startedAt: number, o?: StereoRecorderOptions) => {
  const buf = new WavBuffer(rate, 2);
  const r = new StereoRecorder(rate, startedAt, buf, o);
  return { r, wav: () => (void r.finish(), buf.wav()) };
};

describe("wav", () => {
  test("encodes a valid stereo PCM16 header", () => {
    const wav = encodeWav([new Int16Array([1, 2]), new Int16Array([3, 4])], 16000);
    const v = new DataView(wav);
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(8);
    expect(samples(wav, 0)).toEqual([1, 2]);
    expect(samples(wav, 1)).toEqual([3, 4]);
  });

  test("recorder: caller sequential, agent placed at arrival and never overlapping itself", () => {
    // 1 kHz so 1 ms = 1 sample.
    const { r, wav: out } = rec(1000, 0);
    r.addCaller(le(1, 1, 1, 1, 1, 1, 1, 1), 2); // mic starts 2 ms in (voice session connecting)
    r.addCaller(le(2), 50); // then sequential: a late frame doesn't open a gap
    r.addAgent(le(5, 5), 3); // arrives at 3 ms
    r.addAgent(le(6, 6), 3); // same burst: queued right after, not on top
    r.addAgent(le(7), 9);
    const wav = out();
    expect(samples(wav, 0)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(samples(wav, 1)).toEqual([0, 0, 0, 5, 5, 6, 6, 0, 0, 7, 0]);
  });

  test("recorder: drops audio past maxSamples; extend() records further and never shrinks", () => {
    const { r, wav: out } = rec(1000, 0, { maxSamples: 2 });
    r.addCaller(le(1, 1));
    r.addCaller(le(2)); // past the 2-sample limit: dropped
    r.addAgentAt(le(5), 2); // starts at the limit: dropped
    r.extend(0.001); // 1 sample: shorter than it has, ignored
    r.addCaller(le(3)); // dropped
    r.extend(0.004); // 4 samples
    r.addCaller(le(3));
    r.addAgentAt(le(7), 3);
    const wav = out();
    expect(samples(wav, 0)).toEqual([1, 1, 3, 0]);
    expect(samples(wav, 1)).toEqual([0, 0, 0, 7]);
  });

  test("recorder: agent audio landing after its part was written goes in late rather than lost", () => {
    const { r, wav } = rec(1000, 0, { settleSeconds: 0.002, blockSeconds: 0.001 });
    r.addCaller(le(1, 1, 1, 1, 1, 1));
    r.addAgentAt(le(7), 0); // 6 ms behind the caller track: samples 0–3 are written already
    const out = wav();
    expect(samples(out, 1)).toEqual([0, 0, 0, 0, 7, 0]);
  });
});

// The in-memory recorder this one replaced, as the reference for the equivalence tests.
class InMemoryRecorder {
  private caller: Int16Array[] = [];
  private callerSamples = 0;
  private agent: { at: number; pcm: Int16Array }[] = [];
  private agentEnd = 0;
  constructor(private rate: number, private startedAt: number, private maxSamples = rate * 60 * 20) {}
  extend(seconds: number) {
    this.maxSamples = Math.max(this.maxSamples, Math.round(seconds * this.rate));
  }
  addCaller(bytes: Uint8Array, now?: number) {
    if (this.callerSamples >= this.maxSamples) return;
    if (this.callerSamples === 0 && now !== undefined) {
      const lead = Math.min(this.maxSamples, Math.max(0, Math.round(((now - this.startedAt) / 1000) * this.rate)));
      this.caller.push(new Int16Array(lead));
      this.callerSamples = lead;
    }
    const pcm = toPcm16(bytes, "l16");
    this.caller.push(pcm);
    this.callerSamples += pcm.length;
  }
  padCaller(now: number) {
    const at = Math.min(this.maxSamples, Math.round(((now - this.startedAt) / 1000) * this.rate));
    if (at <= this.callerSamples) return;
    this.caller.push(new Int16Array(at - this.callerSamples));
    this.callerSamples = at;
  }
  addAgent(bytes: Uint8Array, now: number) {
    this.addAgentAt(bytes, now - this.startedAt);
  }
  addAgentAt(bytes: Uint8Array, ms: number) {
    const at = Math.max(Math.round((Math.max(0, ms) / 1000) * this.rate), this.agentEnd);
    if (at >= this.maxSamples) return;
    const pcm = toPcm16(bytes, "l16");
    this.agent.push({ at, pcm });
    this.agentEnd = at + pcm.length;
  }
  toWav(): ArrayBuffer {
    const n = Math.min(this.maxSamples, Math.max(this.callerSamples, this.agentEnd));
    const left = new Int16Array(n);
    let pos = 0;
    for (const c of this.caller) {
      left.set(c.subarray(0, Math.max(0, n - pos)), pos);
      pos += c.length;
    }
    const right = new Int16Array(n);
    for (const a of this.agent) right.set(a.pcm.subarray(0, Math.max(0, n - a.at)), a.at);
    return encodeWav([left, right], this.rate);
  }
}

type Op =
  | { op: "caller"; bytes: Uint8Array; now?: number }
  | { op: "agent"; bytes: Uint8Array; now: number }
  | { op: "agentAt"; bytes: Uint8Array; ms: number }
  | { op: "pad"; now: number }
  | { op: "extend"; seconds: number };

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noise = (rnd: () => number, n: number) => le(...Array.from({ length: n }, () => Math.floor(rnd() * 65536) - 32768));

/**
 * A call as the recorder is fed: the caller track streams 20 ms frames (sideband: no clock;
 * browser: wall clock, after a lead-in), the agent's replies come in bursts generated ahead of
 * the clock (a little behind it at worst), with dropped frames (on the caller's too, which
 * leaves its track behind the clock); then, for a takeover, a silent
 * transfer gap, padCaller and both on the wall clock. Agent audio is never more than `lagMs`
 * behind the caller track.
 */
function callFeed(seed: number, o: { rate: number; ms: number; browser: boolean; takeover: boolean; lagMs: number; callerDrops: number }): Op[] {
  const rnd = mulberry32(seed);
  const ops: Op[] = [];
  const perMs = o.rate / 1000;
  const frame = 20;
  let agentFrom = -1; // ms the current reply is placed from, -1: none
  let t = o.browser ? 100 + Math.floor(rnd() * 400) : 0;
  const end = o.ms;
  const sidebandEnd = o.takeover ? Math.floor(end * 0.4) : end;
  for (; t < sidebandEnd; t += frame) {
    if (rnd() >= o.callerDrops) ops.push({ op: "caller", bytes: noise(rnd, frame * perMs), ...(o.browser ? { now: t + Math.floor(rnd() * 5) } : {}) });
    if (agentFrom < 0 && rnd() < 0.008) agentFrom = t - Math.floor(rnd() * o.lagMs);
    if (agentFrom >= 0) {
      // a burst of a reply: several frames at once, ahead of the clock
      for (let i = Math.floor(rnd() * 6); i > 0; i--) {
        const len = 10 + Math.floor(rnd() * 30);
        if (rnd() < 0.9) ops.push(o.browser ? { op: "agent", bytes: noise(rnd, len * perMs), now: agentFrom } : { op: "agentAt", bytes: noise(rnd, len * perMs), ms: agentFrom });
        agentFrom += len;
      }
      if (rnd() < 0.05) agentFrom = -1;
    }
    if (rnd() < 0.002) ops.push({ op: "extend", seconds: (end / 1000) * (0.5 + rnd()) });
  }
  if (o.takeover) {
    ops.push({ op: "extend", seconds: end / 1000 });
    t += 1000 + Math.floor(rnd() * 3000); // the transfer
    let started = false;
    for (; t < end; t += frame) {
      if (!started) ops.push({ op: "pad", now: t });
      started = true;
      ops.push({ op: "caller", bytes: noise(rnd, frame * perMs) });
      if (rnd() < 0.6) ops.push({ op: "agent", bytes: noise(rnd, frame * perMs), now: t + Math.floor(rnd() * 5) });
    }
  }
  return ops;
}

function play(ops: Op[], r: { addCaller(b: Uint8Array, now?: number): void; addAgent(b: Uint8Array, now: number): void; addAgentAt(b: Uint8Array, ms: number): void; padCaller(now: number): void; extend(s: number): void }) {
  for (const o of ops) {
    if (o.op === "caller") r.addCaller(o.bytes, o.now);
    else if (o.op === "agent") r.addAgent(o.bytes, o.now);
    else if (o.op === "agentAt") r.addAgentAt(o.bytes, o.ms);
    else if (o.op === "pad") r.padCaller(o.now);
    else r.extend(o.seconds);
  }
}

describe("streaming recorder ≡ in-memory recorder", () => {
  const cases = [
    { name: "sideband", browser: false, takeover: false },
    { name: "browser (lead-in, wall clock)", browser: true, takeover: false },
    { name: "sideband then takeover (padCaller)", browser: false, takeover: true },
  ];
  for (const c of cases) {
    for (const [label, opts, maxSeconds] of [
      ["defaults", {}, undefined],
      ["tiny blocks and settle window", { settleSeconds: 0.25, blockSeconds: 0.03 }, undefined],
      ["capped mid-call", { settleSeconds: 0.25, blockSeconds: 0.1 }, 6],
    ] as const) {
      test(`${c.name}, ${label}: byte-identical WAV`, () => {
        for (let seed = 1; seed <= 4; seed++) {
          const rate = 8000;
          const ops = callFeed(seed * 7919 + c.name.length, { rate, ms: 12_000, browser: c.browser, takeover: c.takeover, lagMs: 200, callerDrops: 0.03 });
          const ref = new InMemoryRecorder(rate, 0, maxSeconds && maxSeconds * rate);
          const { r, wav } = rec(rate, 0, { ...opts, ...(maxSeconds ? { maxSamples: maxSeconds * rate } : {}) });
          play(ops, ref);
          play(ops, r);
          const want = new Uint8Array(ref.toWav());
          const got = new Uint8Array(wav());
          expect(got.length).toBe(want.length);
          expect(Buffer.compare(got, want)).toBe(0);
        }
      });
    }
  }

  test("memory stays at a few seconds of audio over a long call", () => {
    const rate = 1000; // a 60-min call at 1 kHz: the bound is in seconds, whatever the rate
    const ops = callFeed(42, { rate, ms: 60 * 60_000, browser: false, takeover: true, lagMs: 1000, callerDrops: 0 });
    let written = 0;
    const r = new StereoRecorder(rate, 0, { append: (pcm) => void (written += pcm.length), finish: async () => null });
    let peak = 0;
    let i = 0;
    for (const o of ops) {
      play([o], r);
      if (++i % 50 === 0) peak = Math.max(peak, r.pendingSamples);
    }
    void r.finish();
    expect(Math.round(written / 4 / rate)).toBe(60 * 60); // all of it was written
    // both tracks' tails: the settle window and a block, plus the agent's lead over the caller
    expect(peak).toBeLessThan(20 * rate);
    expect(peak).toBeGreaterThan(5 * rate);
  });
});
