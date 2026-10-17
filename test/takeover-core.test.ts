import { describe, expect, test } from "bun:test";
import { b64decode, b64encode, fromPcm16, Resampler, toPcm16 } from "../src/core/audio";
import { CallSession } from "../src/core/call-session";
import type { AppConfig } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import type { CallRecording, MediaChannel, OwnerAudioLeg, TakeoverState, VoiceSessionHandlers } from "../src/core/ports";
import { setLogSink, type LogRecord } from "../src/core/log";
import { OwnerBridge, TakeoverTokens, takeoverTokenFrom, takeoverUri } from "../src/core/takeover";
import type { CallEvent } from "../src/core/types";
import { loadRepoConfig, scripted } from "./helpers";

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("takeover audio", () => {
  test("G.711 encode round-trips through decode", () => {
    const pcm = Int16Array.from([0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000, 32767, -32768]);
    for (const codec of ["pcmu", "pcma"] as const) {
      const back = toPcm16(fromPcm16(pcm, codec), codec);
      pcm.forEach((v, i) => expect(Math.abs(back[i]! - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) / 16)));
    }
    const l16 = Int16Array.from([1, -2, 300, -32768]);
    expect([...toPcm16(fromPcm16(l16, "l16"), "l16")]).toEqual([...l16]);
  });

  test("the resampler doubles and halves 20 ms frames, joining them smoothly", () => {
    const up = new Resampler(8000, 16000);
    const frames = [0, 1, 2].map(() => up.push(new Int16Array(160).fill(1000)));
    expect(frames.map((f) => f.length)).toEqual([319, 320, 320]);
    expect(frames[2]!.every((v) => v === 1000)).toBe(true);
    const down = new Resampler(16000, 8000);
    const out = [0, 1, 2].map(() => down.push(new Int16Array(320).fill(-2000)));
    expect(out.map((f) => f.length)).toEqual([160, 160, 160]);
    expect(out[2]!.every((v) => v === -2000)).toBe(true);
    const to24 = new Resampler(16000, 24000);
    expect(to24.push(new Int16Array(320)).length + to24.push(new Int16Array(320)).length).toBeGreaterThanOrEqual(959);
  });
});

describe("takeover audio stats", () => {
  test("levels, lengths and the owner's frame gaps per direction; page counters summed per connection", () => {
    let now = 0;
    const bridge = new OwnerBridge("pcma", null, { now: () => now });
    // 1 s of caller audio at full scale and 1 s of a dead mic, with a 300 ms hole in the owner's frames.
    for (let i = 0; i < 50; i++) bridge.callerAudio(b64encode(fromPcm16(new Int16Array(160).fill(32767), "pcma")));
    for (let i = 0; i < 50; i++) {
      now += i === 10 ? 300 : 20;
      bridge.ownerAudio(new Int16Array(320));
    }
    // After a reconnect the time away isn't a gap.
    bridge.ownerReconnected();
    now += 5000;
    bridge.ownerAudio(new Int16Array(320));
    const { text, fields } = bridge.summary(1, [
      { sentFrames: 40, underruns: 1, mutedMs: 0 },
      { sentFrames: 11, underruns: 2, mutedMs: 1500 },
    ]);
    expect(fields).toMatchObject({
      reconnects: 1,
      toOwner: { frames: 50, seconds: 1, peakDbfs: 0 },
      toCaller: { frames: 51, seconds: 1, peakDbfs: -96, rmsDbfs: -96 },
      ownerGaps: { count: 1, longestMs: 300 },
      page: { sentFrames: 51, underruns: 3, mutedMs: 1500, connections: 2 },
    });
    expect(text).toContain("1 gap > 100 ms, longest 300 ms");
    expect(text).toContain("page: 3 underruns, muted 1.5 s");
    expect(new OwnerBridge("pcmu", null, { now: () => 0 }).summary(0, [])).toMatchObject({ fields: { toOwner: { frames: 0, peakDbfs: -96 } } });
  });
});

describe("takeover tokens", () => {
  test("one use each, within the TTL; matched on the takeover domain only", () => {
    let now = 0;
    const tokens = new TakeoverTokens({ now: () => now });
    const a = tokens.create("c1", 1000);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(takeoverUri(a, "x.sip.telnyx.com")).toBe(`sip:cstakeover${a}@x.sip.telnyx.com`);
    expect(takeoverTokenFrom(`cstakeover${a}@X.sip.telnyx.com`, "x.sip.telnyx.com")).toBe(a);
    expect(takeoverTokenFrom(`sip:cstakeover${a}@x.sip.telnyx.com;transport=udp`, "x.sip.telnyx.com")).toBe(a);
    expect(takeoverTokenFrom("takeover@x.sip.telnyx.com", "x.sip.telnyx.com")).toBe("");
    expect(takeoverTokenFrom("+447700900123", "x.sip.telnyx.com")).toBeNull();
    expect(takeoverTokenFrom(`cstakeover${a}@other.sip.telnyx.com`, "x.sip.telnyx.com")).toBeNull();
    expect(tokens.claim(a)).toBe("c1");
    expect(tokens.claim(a)).toBeNull();
    const b = tokens.create("c2", 1000);
    now = 1000;
    expect(tokens.claim(b)).toBeNull();
    const c = tokens.create("c3", 1000);
    tokens.revoke("c3");
    expect(tokens.claim(c)).toBeNull();
  });
});

function fakeLeg() {
  const states: TakeoverState[] = [];
  const audio: Int16Array[] = [];
  let closed = false;
  const leg: OwnerAudioLeg = { sendAudio: (p) => void audio.push(p), notify: (s) => void states.push(s), close: () => void (closed = true) };
  return { leg, states, audio, closed: () => closed };
}

async function rig(opts: { sip?: boolean; refer?: (uri: string, signal: AbortSignal) => Promise<void>; config?: (c: AppConfig) => void } = {}) {
  const config = await loadRepoConfig();
  config.telegram.takeover.max_handover_wait_ms = 0;
  config.telegram.takeover.leg_timeout_ms = 200;
  config.telegram.takeover.reconnect_grace_ms = 50;
  config.luna.progress.enabled = false;
  opts.config?.(config);
  let now = 1_000_000;
  const appended: string[] = [];
  const hangups: string[] = [];
  const toLive: string[] = [];
  const toCaller: string[] = [];
  const refers: string[] = [];
  const referSignals: AbortSignal[] = [];
  const keptFor: number[] = [];
  const summaries: { takenOverAt?: number }[] = [];
  let closed = 0;
  const rec = { caller: [] as number[], owner: [] as number[], finished: 0 };
  const recording: CallRecording = {
    caller: (p, rate) => void rec.caller.push(rate, p.length),
    owner: (p, rate) => void rec.owner.push(rate, p.length),
    finish: () => void rec.finished++,
  };
  const events: CallEvent[] = [];
  const bus = new MemoryEventBus();
  bus.subscribe((e) => void events.push(e));
  let handlers: VoiceSessionHandlers | null = null;
  const media: MediaChannel = { sendAudio: (b) => void toCaller.push(b), clear() {}, close() {} };
  const session = new CallSession({
    meta: { callId: "c1", from: "+441", to: "+442", channel: "phone", startedAt: now },
    callControlId: opts.sip ? "sip:live_1" : "cc1",
    config: () => config,
    voice: {
      async connect(_o, h) {
        handlers = h;
        return {
          sendAudio: (a) => void toLive.push(a),
          append: (_as, t) => void appended.push(t),
          async close() {
            closed++;
          },
          ...(opts.sip
            ? {
                refer: async (uri: string, signal: AbortSignal) => (refers.push(uri), referSignals.push(signal), opts.refer?.(uri, signal)),
                keepRecording: (maxSeconds: number) => (keptFor.push(maxSeconds), recording),
              }
            : {}),
        };
      },
    },
    classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
    agent: { run: async () => ({ toolCalls: [] }), summarize: async (_m, _t, o) => (summaries.push({ takenOverAt: o?.takenOverAt }), { text: "sum" }) },
    bus,
    telephony: { hangup: async (id) => void hangups.push(id) },
    clock: { now: () => now },
    media: opts.sip ? { sendAudio() {}, clear() {}, close() {} } : media,
    mediaViaVoice: opts.sip,
  });
  await session.start(opts.sip ? "pcm24" : "pcma");
  return {
    session,
    config,
    appended,
    hangups,
    toLive,
    toCaller,
    refers,
    referSignals,
    keptFor,
    summaries,
    rec,
    recording,
    events,
    media,
    closed: () => closed,
    handlers: () => handlers!,
    advance: (ms: number) => void (now += ms),
    ended: () => events.find((e): e is Extract<CallEvent, { type: "call.ended" }> => e.type === "call.ended"),
  };
}

const pcma = (ms: number) => b64encode(new Uint8Array(ms * 8).fill(0xd5));

describe("takeover: media stream", () => {
  test("the handover line, then Live goes and the leg carries the owner both ways", async () => {
    const r = await rig();
    r.handlers().onTranscriptDelta("caller", "u1", "Is Peter there?");
    r.handlers().onTranscriptDone("caller", "u1", "Is Peter there?");
    const o = fakeLeg();
    const handle = r.session.takeOver(o.leg, null);
    expect(r.session.phase).toBe("handing_over");
    expect(r.appended.at(-1)).toBe(r.config.telegram.takeover.handover_text);
    expect(r.events.some((e) => e.type === "takeover.started")).toBe(true);
    await until(() => r.session.phase === "taken_over");
    expect(o.states).toEqual([{ type: "connecting" }, { type: "live" }]);
    expect(r.closed()).toBe(1);
    expect(r.events.some((e) => e.type === "takeover.live")).toBe(true);

    // Caller → owner (8 kHz A-law → 16 kHz PCM16), owner → caller.
    const sentToLive = r.toLive.length;
    r.session.onCallerAudio(pcma(20));
    expect(r.toLive.length).toBe(sentToLive);
    expect(o.audio[0]!.length).toBe(319);
    handle.ownerAudio(new Int16Array(320).fill(1000));
    expect(b64decode(r.toCaller.at(-1)!).length).toBe(160);

    // Late Live audio doesn't reach the caller; its close doesn't end the call; no steering.
    const n = r.toCaller.length;
    r.handlers().onAudio(pcma(20));
    expect(r.toCaller.length).toBe(n);
    r.handlers().onClose("close_requested");
    expect(r.session.phase).toBe("taken_over");
    expect(r.session.steerFromOwner("hi", "commentary")).toEqual({ ok: false, reason: "you've taken this call over" });
    expect(r.session.takeoverBlocked()).toBe("the call is already taken over");

    // Live is billed to the takeover; the caller's hangup tells the page and closes it, and the
    // takeover's audio stats go to the call's log and timeline.
    handle.pageStats({ sentFrames: 1, underruns: 2, mutedMs: 0 });
    r.advance(60_000);
    const logs: LogRecord[] = [];
    const restore = setLogSink((l) => void logs.push(l));
    await r.session.stop("caller hung up", "caller").finally(restore);
    const stats = logs.find((l) => l.scope === "takeover" && l.msg.startsWith("takeover audio:"));
    expect(stats).toMatchObject({ callId: "c1", liveSeconds: 60, reconnects: 0, toOwner: { frames: 1 }, toCaller: { frames: 1 }, page: { underruns: 2 } });
    expect(r.events.some((e) => e.type === "note" && e.message === stats!.msg)).toBe(true);
    expect(o.states.at(-1)).toEqual({ type: "ended", reason: "caller hung up" });
    expect(o.closed()).toBe(true);
    expect(r.ended()!.costs!.liveSeconds).toBe(0);
    expect(r.summaries).toEqual([{ takenOverAt: 0 }]);
  });

  test("the owner hangs up from Telegram at once; a bot hangup is ignored", async () => {
    const r = await rig();
    r.session.takeOver(fakeLeg().leg, null);
    await until(() => r.session.phase === "taken_over");
    expect(r.session.hangUpFromOwner()).toEqual({ ok: true });
    await until(() => !!r.ended());
    expect(r.ended()).toMatchObject({ endedBy: "owner" });
    expect(r.hangups).toEqual(["cc1"]);
  });

  test("the owner's page leaving hangs up after the grace period, unless it's back", async () => {
    const r = await rig();
    const o = fakeLeg();
    const h = r.session.takeOver(o.leg, null);
    await until(() => r.session.phase === "taken_over");
    h.ownerLeft();
    expect(r.session.ownerAway).toBe(true);
    const back = fakeLeg();
    const h2 = r.session.reattachOwner(back.leg);
    expect(back.states).toEqual([{ type: "live" }]);
    await Bun.sleep(80);
    expect(r.ended()).toBeUndefined();
    // The old handle is dead.
    h.ownerLeft();
    expect(r.session.ownerAway).toBe(false);
    h2.ownerLeft();
    await until(() => !!r.ended());
    expect(r.ended()).toMatchObject({ endedBy: "owner", reason: "the owner left the call" });
  });
});

describe("takeover: OpenAI SIP", () => {
  test("REFER, the sideband closing is ignored, the transferred leg connects; the recording goes on", async () => {
    const r = await rig({ sip: true });
    const o = fakeLeg();
    const h = r.session.takeOver(o.leg, "sip:cstakeoverabc@d");
    await until(() => r.refers.length > 0);
    expect(r.refers).toEqual(["sip:cstakeoverabc@d"]);
    r.handlers().onClose("remote_hangup");
    expect(r.session.phase).toBe("handing_over");
    expect(r.ended()).toBeUndefined();

    expect(r.session.takeoverLegOffered("v3:new")).toBe(true);
    expect(r.session.takeoverLegOffered("v3:other")).toBe(false);
    r.session.attachTakeoverLeg(r.media, "pcma");
    expect(r.session.phase).toBe("taken_over");
    expect(o.states.at(-1)).toEqual({ type: "live" });

    r.session.onCallerAudio(pcma(20));
    h.ownerAudio(new Int16Array(320));
    expect(r.rec.caller).toEqual([8000, 160]);
    expect(r.rec.owner).toEqual([16000, 320]);
    expect(r.toCaller.length).toBe(1);

    // The kept recording is asked to last at least the takeover's limit.
    expect(r.keptFor).toHaveLength(1);
    expect(r.keptFor[0]!).toBeGreaterThanOrEqual(r.config.telegram.takeover.max_seconds);

    await r.session.stop("hangup: normal_clearing (caller)", "caller");
    await r.session.finished;
    expect(r.rec.finished).toBe(1);
    expect(o.closed()).toBe(true);
  });

  test("a failed REFER: the agent carries on and the page hears why", async () => {
    const r = await rig({ sip: true, refer: async () => Promise.reject(new Error("409 conflict")) });
    const o = fakeLeg();
    r.session.takeOver(o.leg, "sip:cstakeoverabc@d");
    await until(() => r.session.phase === "active");
    expect(o.states.at(-1)).toEqual({ type: "error", message: "the transfer failed: 409 conflict" });
    expect(r.events.find((e) => e.type === "takeover.failed")).toMatchObject({ reason: "the transfer failed: 409 conflict" });
    expect(r.appended.at(-1)).toBe(r.config.telegram.takeover.failed_text);
    expect(r.session.steerFromOwner("hi", "commentary")).toEqual({ ok: true });
    // Live's session ending now ends the call as before.
    r.handlers().onClose("remote_hangup");
    await until(() => !!r.ended());
    expect(r.ended()).toMatchObject({ endedBy: "caller" });
  });

  test("a retry after a failed REFER extends the recording to the new attempt's limit", async () => {
    let fail = true;
    const r = await rig({ sip: true, refer: async () => (fail ? Promise.reject(new Error("409 conflict")) : undefined) });
    r.session.takeOver(fakeLeg().leg, "sip:cstakeoverabc@d");
    await until(() => r.session.phase === "active");
    fail = false;
    r.advance(10 * 60_000);
    r.session.takeOver(fakeLeg().leg, "sip:cstakeoverdef@d");
    await until(() => r.keptFor.length === 2);
    // Ten minutes in, the rest of the call still fits.
    expect(r.keptFor[1]!).toBeGreaterThanOrEqual(600 + r.config.telegram.takeover.max_seconds);
  });

  test("a REFER that never answers is aborted after leg_timeout_ms and the call hung up", async () => {
    // Never resolves; rejects once its signal aborts (as the SDK does).
    const refer = (_uri: string, signal: AbortSignal) =>
      new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const r = await rig({ sip: true, refer, config: (c) => void (c.telegram.takeover.leg_timeout_ms = 50) });
    const o = fakeLeg();
    r.session.takeOver(o.leg, "sip:cstakeoverabc@d");
    await until(() => r.refers.length > 0);
    expect(r.referSignals[0]!.aborted).toBe(false);
    await until(() => !!r.ended(), 2000);
    expect(r.referSignals[0]!.aborted).toBe(true);
    expect(r.events.find((e) => e.type === "takeover.failed")).toMatchObject({ reason: "the transfer request timed out" });
    expect(o.states).toContainEqual({ type: "error", message: "the transfer request timed out" });
    // OpenAI still holds the caller: the session's phone leg is hung up.
    expect(r.hangups).toEqual(["sip:live_1"]);
    expect(r.ended()).toMatchObject({ reason: "the transfer request timed out", endedBy: "system" });
    // The aborted REFER's rejection doesn't also report a failed transfer.
    expect(o.states.some((s) => s.type === "error" && s.message.startsWith("the transfer failed"))).toBe(false);
  });

  test("a transferred leg that never connects ends the call", async () => {
    const r = await rig({ sip: true });
    const o = fakeLeg();
    r.session.takeOver(o.leg, "sip:cstakeoverabc@d");
    await until(() => !!r.ended(), 2000);
    expect(r.ended()).toMatchObject({ reason: "the transferred call didn't connect", endedBy: "system" });
    expect(o.states).toContainEqual({ type: "error", message: "the transferred call didn't connect" });
  });

  test("a leg Telnyx offered but whose stream never came is hung up", async () => {
    const r = await rig({ sip: true });
    r.session.takeOver(fakeLeg().leg, "sip:cstakeoverabc@d");
    await until(() => r.refers.length > 0);
    r.session.takeoverLegOffered("v3:new");
    await until(() => !!r.ended(), 2000);
    expect(r.hangups).toEqual(["v3:new"]);
  });

  test("the caller hanging up during the handover line ends the call", async () => {
    const r = await rig({ sip: true, config: (c) => void (c.telegram.takeover.max_handover_wait_ms = 2000) });
    const o = fakeLeg();
    r.session.takeOver(o.leg, "sip:cstakeoverabc@d");
    r.handlers().onClose("remote_hangup");
    await until(() => !!r.ended());
    expect(r.ended()).toMatchObject({ endedBy: "caller" });
    expect(o.states.at(-1)).toMatchObject({ type: "ended" });
    await Bun.sleep(20);
    expect(r.refers).toEqual([]);
  });
});
