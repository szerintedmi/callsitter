import { describe, expect, test } from "bun:test";
import { b64encode } from "../src/core/audio";
import { CallSession, type CallSessionDeps } from "../src/core/call-session";
import { MemoryEventBus } from "../src/core/event-bus";
import type { AppConfig, TellLive } from "../src/core/config";
import type { Agent, VoiceSessionHandlers } from "../src/core/ports";
import type { CallEvent } from "../src/core/types";
import { cls, loadRepoConfig, scripted } from "./helpers";

const FALLBACK = "No specific guidance; carry on naturally.";
/** A tell_live on the repo's defaults (send: when_agent_idle, max_hold_ms: 8000), unless overridden. */
const msg = (as: TellLive["as"], text: string, o: Partial<TellLive> = {}): TellLive => ({
  as,
  text,
  send: "when_agent_idle",
  max_hold_ms: 8000,
  ...o,
});

async function rig(
  opts: { agent?: Agent; sip?: boolean; config?: (c: AppConfig) => void } & Pick<CallSessionDeps, "dryRun"> = {},
) {
  const config = await loadRepoConfig();
  opts.config?.(config);
  config.flow.silence = { ...config.flow.silence, enabled: true, after_ms: 7000, max_prompts: 2, hang_up: true };
  config.connection.speech_detection = { caller_dbfs: -40, agent_dbfs: -50 };
  let now = 1_000_000;
  const appended: string[] = [];
  const hangups: string[] = [];
  const sent: string[] = [];
  const kinds: string[] = [];
  const delegations: (string | undefined)[] = [];
  const bus = new MemoryEventBus();
  const notes: string[] = [];
  const appends: Extract<CallEvent, { type: "live.append" }>[] = [];
  bus.subscribe((e) => {
    if (e.type === "note") notes.push(e.message);
    if (e.type === "live.append") appends.push(e);
  });
  let handlers: VoiceSessionHandlers | null = null;
  const session = new CallSession({
    meta: { callId: "c1", from: "+441", to: "+442", startedAt: now },
    callControlId: "cc1",
    config: () => config,
    voice: {
      async connect(_o, h) {
        handlers = h;
        return {
          sendAudio: (a) => void sent.push(a),
          append: (as, t, id) => void (appended.push(t), kinds.push(as), delegations.push(id)),
          async close() {},
        };
      },
    },
    classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
    agent: opts.agent ?? { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
    bus,
    telephony: { hangup: async (id) => void hangups.push(id) },
    clock: { now: () => now },
    media: { sendAudio() {}, clear() {}, close() {} },
    mediaViaVoice: opts.sip,
    dryRun: opts.dryRun,
  });
  await session.start(opts.sip ? "pcm24" : "pcma");
  return {
    session,
    appended,
    kinds,
    delegations,
    hangups,
    handlers: () => handlers!,
    advance: (ms: number) => {
      now += ms;
      session.checkSilence();
    },
    stall: (ms: number) => {
      now += ms;
      session.keepInputRunning();
    },
    sent,
    notes,
    appends,
    bus,
    config,
    prompt: config.flow.silence.tell_live.text,
  };
}

describe("owner steering from Telegram", () => {
  test("a message goes to Live at once, in a SUPERVISOR line", async () => {
    const r = await rig();
    // The agent is mid-reply: steering still goes out straight away.
    r.handlers().onTranscriptDelta("caller", "c1", "Is he free on Tuesday?");
    expect(r.session.steerFromOwner("  Say I'm free after 3  ", "commentary")).toEqual({ ok: true });
    expect(r.appended.at(-1)).toBe("SUPERVISOR: Say I'm free after 3");
    expect(r.kinds.at(-1)).toBe("commentary");
    expect(r.appends.at(-1)).toMatchObject({ source: "owner", as: "commentary", heldMs: 0 });
    expect(r.session.orch.ownerMessages).toEqual(["Say I'm free after 3"]);
  });

  test("it goes as the kind it's given, the text as it is", async () => {
    const r = await rig();
    r.session.steerFromOwner("stop, don't give that", "instructions");
    r.session.steerFromOwner("!It's a genuine call.", "thinking");
    expect(r.kinds.slice(-2)).toEqual(["instructions", "thinking"]);
    expect(r.appended.slice(-2)).toEqual(["SUPERVISOR: stop, don't give that", "SUPERVISOR: !It's a genuine call."]);
  });

  test("refused when empty, turned off, or after the call ended", async () => {
    const r = await rig();
    expect(r.session.steerFromOwner(" ", "commentary")).toEqual({ ok: false, reason: "the message is empty" });
    r.config.telegram.steering.enabled = false;
    expect(r.session.steerFromOwner("hi", "commentary")).toMatchObject({ ok: false });
    r.config.telegram.steering.enabled = true;
    await r.session.stop("caller hung up");
    expect(r.session.steerFromOwner("hi", "commentary")).toEqual({ ok: false, reason: "that call has ended" });
    expect(r.appends.filter((a) => a.source === "owner")).toEqual([]);
  });

  test("Luna's guidance from a run that started before the owner steered is dropped", async () => {
    let finish!: (v: { instructions: string; toolCalls: [] }) => void;
    const r = await rig({
      agent: { run: () => new Promise((res) => (finish = res)), summarize: async () => ({ text: "" }) },
    });
    const run = r.session.orch.runLuna("unsure", { rule: { stage: "clarify", message: msg("commentary", "SUPERVISOR: {luna_response}") } });
    r.session.steerFromOwner("keep them talking", "commentary");
    finish({ instructions: "Wrap up now.", toolCalls: [] });
    expect(await run).toBe("");
    expect(r.appended).not.toContain("SUPERVISOR: Wrap up now.");
  });

  test("at hangup, the last rolling summary is reused if the caller said nothing new after it", async () => {
    let summarized = 0;
    const r = await rig({ agent: { run: async () => ({ toolCalls: [] }), summarize: async () => (summarized++, { text: "Luna's final." }) } });
    const summaries: { text: string; reused?: boolean }[] = [];
    r.bus.subscribe((e) => void (e.type === "summary" && summaries.push({ text: e.text, ...(e.reused ? { reused: e.reused } : {}) })));
    r.handlers().onTranscriptDelta("caller", "c1", "It's Sarah.");
    r.session.orch.lastProgress = { summary: "Sarah is calling.", callerRev: r.session.orch.transcript.callerRev };
    // The agent's goodbye isn't the caller's.
    r.handlers().onTranscriptDelta("agent", "a1", "Bye then.");
    await r.session.stop("caller hung up");
    expect(summaries).toEqual([{ text: "Sarah is calling.", reused: true }]);
    expect(summarized).toBe(0);

    // New caller words after it: Luna writes the final summary.
    const r2 = await rig({ agent: { run: async () => ({ toolCalls: [] }), summarize: async () => (summarized++, { text: "Luna's final." }) } });
    const s2: string[] = [];
    r2.bus.subscribe((e) => void (e.type === "summary" && s2.push(e.text)));
    r2.handlers().onTranscriptDelta("caller", "c1", "It's Sarah.");
    r2.session.orch.lastProgress = { summary: "Sarah is calling.", callerRev: r2.session.orch.transcript.callerRev };
    r2.handlers().onTranscriptDelta("caller", "c2", "Call me back on 0207 946 0000.");
    await r2.session.stop("caller hung up");
    expect(s2).toEqual(["Luna's final."]);
    expect(summarized).toBe(1);
  });

  test("steering while Live waits for help doesn't turn Luna's answer into the fallback", async () => {
    let finish!: (v: { instructions: string; toolCalls: [] }) => void;
    const r = await rig({ agent: { run: () => new Promise((res) => (finish = res)), summarize: async () => ({ text: "" }) } });
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    r.session.steerFromOwner("ask when they can redeliver", "commentary");
    finish({ instructions: "Ask what delivery slots they can offer.", toolCalls: [] });
    await Bun.sleep(0);
    r.session.flushHeldInstructions();
    const answer = r.appends.find((a) => a.delegationId === "d1")!;
    expect(answer.fallback).toBeUndefined();
    expect(answer.text).toContain("Ask what delivery slots they can offer.");
  });

  test("the owner hangs up: once the agent's goodbye has played", async () => {
    const r = await rig();
    expect(r.session.hangUpFromOwner()).toEqual({ ok: true });
    r.session.checkPendingHangup();
    await r.session.finished;
    expect(r.hangups).toEqual(["cc1"]);
    expect(r.session.hangUpFromOwner()).toEqual({ ok: false, reason: "that call has ended" });
  });

  test("the summary sees what the owner said", async () => {
    let seen: readonly string[] | undefined;
    const r = await rig({
      agent: { run: async () => ({ toolCalls: [] }), summarize: async (_m, _t, o) => ((seen = o?.ownerMessages), { text: "Sarah called." }) },
    });
    const summaries: string[] = [];
    r.bus.subscribe((e) => e.type === "summary" && summaries.push(e.text));
    r.handlers().onTranscriptDelta("caller", "c1", "It's Sarah.");
    r.session.steerFromOwner("ask for her number", "commentary");
    await r.session.stop("caller hung up");
    expect(seen).toEqual(["ask for her number"]);
    expect(summaries).toEqual(["Sarah called."]);
  });
});

describe("call session over OpenAI SIP (caller audio only reflected by the sideband)", () => {
  /** 100 ms of 24 kHz PCM16LE at a speech-like level (about -12 dBFS). */
  const loud = () => {
    const pcm = new Int16Array(2400);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? 8000 : -8000;
    return b64encode(new Uint8Array(pcm.buffer));
  };

  test("reflected caller speech counts as activity: no silence prompt while the caller talks", async () => {
    const r = await rig({ sip: true });
    for (let t = 0; t < 12_000; t += 1000) {
      r.handlers().onCallerAudio!(loud());
      r.advance(1000);
    }
    expect(r.appended).not.toContain(r.prompt);
    // Once the caller stops, the watchdog still works.
    r.advance(7000);
    expect(r.appended).toContain(r.prompt);
  });

  test("the call's notes say how much reflected caller audio arrived, and its gaps", async () => {
    const r = await rig({ sip: true });
    for (let i = 0; i < 10; i++) {
      r.handlers().onCallerAudio!(loud());
      r.advance(100);
    }
    r.advance(600);
    for (let i = 0; i < 5; i++) {
      r.handlers().onCallerAudio!(loud());
      r.advance(100);
    }
    await r.session.hangup("test");
    expect(r.notes).toContain("sideband caller audio: 1.5 s received over 2.1 s, 1 gap ≥ 200 ms, longest 600 ms");
  });

  test("Live ending the session ends the call without a hangup; a dropped sideband still hangs up", async () => {
    const ended = await rig({ sip: true });
    ended.handlers().onClose("remote_hangup");
    expect(ended.session.phase).not.toBe("active");
    expect(ended.hangups).toEqual([]);

    const dropped = await rig({ sip: true });
    dropped.handlers().onClose();
    expect(dropped.hangups).toEqual(["cc1"]);
  });

  test("reflected audio is never sent back to Live, and no silence is fed in", async () => {
    const r = await rig({ sip: true });
    r.handlers().onCallerAudio!(loud());
    r.stall(5000);
    expect(r.sent).toEqual([]);
  });
});

describe("call session: recorded greeting", () => {
  test("plays at once while Live connects; Live starts from it; the caller's early words reach Live", async () => {
    const config = await loadRepoConfig();
    const media: string[] = [];
    const toLive: string[] = [];
    let opts: any;
    let connected!: () => void;
    const session = new CallSession({
      meta: { callId: "c1", from: "+441", to: "+442", startedAt: 0 },
      callControlId: "cc1",
      config: () => config,
      voice: {
        async connect(o) {
          opts = o;
          await new Promise<void>((r) => (connected = r));
          return { sendAudio: (a) => void toLive.push(a), append() {}, async close() {} };
        },
      },
      classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
      agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
      bus: new MemoryEventBus(),
      telephony: { hangup: async () => {} },
      clock: { now: () => Date.now() },
      media: { sendAudio: (a) => void media.push(a), clear() {}, close() {} },
      greetings: { get: (codec) => (codec === "pcma" ? new Uint8Array(1600).fill(0x12) : null) },
    });
    const started = session.start("pcma");
    await Bun.sleep(0);
    expect(media.map((m) => atob(m).length)).toEqual([800, 800]); // 200 ms greeting, in 100 ms chunks
    expect(opts.greeted).toBe(config.live.greeting);
    expect(session.orch.transcript.all().map((e) => [e.speaker, e.text])).toEqual([["agent", config.live.greeting]]);
    session.onCallerAudio("AAAA"); // "Hi" over the greeting, before Live is up
    connected();
    await started;
    expect(toLive).toContain("AAAA");
    await session.stop("test");
  });

  test("without a recording (or for another codec), Live is asked to greet as before", async () => {
    const r = await rig();
    expect(r.sent).toHaveLength(0);
    await r.session.stop("test");
  });
});

describe("call session: Luna around hangup", () => {
  test("a running Luna call finishes after hangup; call.ended and the summary come after it", async () => {
    let release!: () => void;
    const summarized: (string | undefined)[] = [];
    const agent: Agent = {
      async run(input) {
        await new Promise<void>((r) => (release = r));
        const result = await input.tools.endCall("done");
        return { instructions: "Say goodbye.", toolCalls: [{ name: "end_call", args: {}, result }], responseId: "resp_1" };
      },
      summarize: async (_m, _t, o) => (summarized.push(o?.previousResponseId), { text: "Sarah called about dinner." }),
    };
    const r = await rig({ agent });
    const order: string[] = [];
    r.bus.subscribe((e) => void order.push(e.type));
    r.handlers().onTranscriptDelta("caller", "c1", "It's Sarah, please ask him to call me back.");
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    const stopped = r.session.stop("caller hung up");
    await Bun.sleep(0);
    expect(order).not.toContain("call.ended"); // waiting for Luna
    release();
    await stopped;
    expect(order.filter((t) => ["tool", "luna", "call.ended", "summary"].includes(t))).toEqual(["tool", "luna", "call.ended", "summary"]);
    expect(r.appended.some((a) => a.includes("Say goodbye."))).toBe(false); // no voice session to guide
    expect(summarized).toEqual(["resp_1"]);
  });

  test("a Luna call still running after drain_timeout_ms is cancelled", async () => {
    let aborted = false;
    const agent: Agent = {
      run: (input) =>
        new Promise((_, reject) => input.signal?.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted"))))),
      summarize: async () => ({ text: "" }),
    };
    const r = await rig({ agent });
    r.config.luna.drain_timeout_ms = 20;
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    await r.session.stop("caller hung up");
    expect(aborted).toBe(true);
    expect(r.notes).toContain("Luna still running 20 ms after hangup; cancelled");
    expect(r.notes.some((n) => n.startsWith("Luna failed"))).toBe(false);
  });

  test("Luna's end_call tool hangs up without waiting on itself", async () => {
    const agent: Agent = {
      async run(input) {
        const result = await input.tools.endCall("conversation finished");
        return { toolCalls: [{ name: "end_call", args: {}, result }] };
      },
      summarize: async () => ({ text: "" }),
    };
    const r = await rig({ agent });
    r.config.luna.drain_timeout_ms = 60_000;
    const ended = new Promise<void>((res) => r.bus.subscribe((e) => void (e.type === "call.ended" && res())));
    r.handlers().onDelegation({ id: "d1" });
    await Promise.race([ended, Bun.sleep(1000).then(() => Promise.reject(new Error("deadlocked")))]);
    expect(r.hangups).toEqual(["cc1"]);
  });
});

describe("call session: delegation", () => {
  test("Luna's answer is appended once, with the delegation's id", async () => {
    const agent: Agent = { run: async () => ({ instructions: "Say he's out until six.", toolCalls: [] }), summarize: async () => ({ text: "" }) };
    const r = await rig({ agent });
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    expect(r.appended).toHaveLength(1);
    expect(r.appended[0]).toContain("Say he's out until six.");
    expect(r.delegations).toEqual(["d1"]);
    await r.session.stop("test");
  });

  test("without guidance the delegation is answered with the fallback", async () => {
    const r = await rig();
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    expect(r.appended).toEqual([FALLBACK]);
    expect(r.delegations).toEqual(["d1"]);
    await r.session.stop("test");
  });
});

describe("call session lifecycle", () => {
  /** A session whose Live connection never comes up unless aborted (or as `deps` says). */
  async function stalled(tune: (c: Awaited<ReturnType<typeof loadRepoConfig>>) => void, deps: Partial<CallSessionDeps> = {}) {
    const config = await loadRepoConfig();
    tune(config);
    const hangups: string[] = [];
    const ended: Extract<CallEvent, { type: "call.ended" }>[] = [];
    const bus = new MemoryEventBus();
    bus.subscribe((e) => void (e.type === "call.ended" && ended.push(e)));
    let signal: AbortSignal | undefined;
    const all: CallSessionDeps = {
      meta: { callId: "c1", from: "+441", to: "+442", startedAt: Date.now() },
      callControlId: "cc1",
      config: () => config,
      voice: {
        connect: (o) =>
          new Promise((_, reject) => {
            signal = o.signal;
            o.signal?.addEventListener("abort", () => reject(o.signal!.reason));
          }),
      },
      classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
      agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
      bus,
      telephony: { hangup: async (id) => void hangups.push(id) },
      clock: { now: () => Date.now() },
      media: { sendAudio() {}, clear() {}, close() {} },
      ...deps,
    };
    const notes: string[] = [];
    bus.subscribe((e) => void (e.type === "note" && notes.push(e.message)));
    return { session: new CallSession(all), hangups, ended, notes, signal: () => signal };
  }

  test("time_up asks for the goodbye before max call length, then the call ends", async () => {
    const r = await rig({
      config: (c) => {
        c.flow.timing.max_call_seconds = 0.2;
        c.flow.timing.time_up = { ...c.flow.timing.time_up!, seconds_left: 0.1 };
      },
    });
    const text = r.config.flow.timing.time_up!.tell_live.text;
    const ended: string[] = [];
    r.bus.subscribe((e) => void (e.type === "call.ended" && ended.push(e.reason)));
    await Bun.sleep(150);
    expect(r.appended).toEqual([text]);
    expect(r.kinds.at(-1)).toBe("commentary");
    expect(r.session.orch.stage).toBe("time_up");
    expect(r.hangups).toEqual([]);
    await Bun.sleep(100);
    await r.session.finished;
    expect(ended).toEqual(["max call length reached"]);
    expect(r.hangups).toEqual(["cc1"]);
  });

  test("max call length applies while Live is still connecting", async () => {
    const r = await stalled((c) => {
      c.flow.timing.max_call_seconds = 0.03;
      c.connection.connect_timeout_ms = 60_000;
    });
    await r.session.start("pcma"); // returns once the deadline hangs up and aborts the connect
    await r.session.finished;
    expect(r.signal()?.aborted).toBe(true);
    expect(r.hangups).toEqual(["cc1"]);
    expect(r.ended.map((e) => e.reason)).toEqual(["max call length reached"]);
    expect(r.session.phase).toBe("finalized");
  });

  test("a Live connection that takes longer than connect_timeout_ms fails the start", async () => {
    const r = await stalled((c) => (c.connection.connect_timeout_ms = 30));
    await expect(r.session.start("pcma")).rejects.toThrow("Live didn't connect within 30 ms");
    expect(r.signal()?.aborted).toBe(true);
    await r.session.stop("test");
  });

  test("a Live session that comes up during hangup is closed before the wrap-up ends", async () => {
    let connected!: () => void;
    let closeDone!: () => void;
    let closing = false;
    // Like LiveSession.close(): every call returns the same shutdown.
    const closed = new Promise<void>((d) => (closeDone = d));
    const r = await stalled(() => {}, {
      voice: {
        // Ignores the abort, as when the connection completes in the same moment.
        connect: () =>
          new Promise((res) =>
            (connected = () =>
              res({
                sendAudio() {},
                append() {},
                close: () => ((closing = true), closed),
              }))),
      },
    });
    let started = false;
    const start = r.session.start("pcma").then(() => (started = true));
    await Bun.sleep(0);
    const stopped = r.session.stop("caller hung up");
    connected();
    await Bun.sleep(10);
    expect(closing).toBe(true);
    expect(started).toBe(false); // waiting for the close
    let finished = false;
    void stopped.then(() => (finished = true));
    await Bun.sleep(10);
    expect(finished).toBe(false);
    closeDone();
    await start;
    await stopped;
    expect(r.session.phase).toBe("finalized");
  });

  test("a carrier hangup that never returns doesn't block the local wrap-up", async () => {
    let voiceClosed = false;
    let mediaClosed = false;
    const r = await stalled((c) => (c.connection.hangup_timeout_ms = 30), {
      voice: { connect: async () => ({ sendAudio() {}, append() {}, close: async () => void (voiceClosed = true) }) },
      telephony: { hangup: () => new Promise<void>(() => {}) },
      media: { sendAudio() {}, clear() {}, close: () => void (mediaClosed = true) },
    });
    await r.session.start("pcma");
    await r.session.hangup("max call length reached");
    expect(voiceClosed).toBe(true);
    expect(mediaClosed).toBe(true);
    expect(r.ended.map((e) => e.reason)).toEqual(["max call length reached"]);
    expect(r.notes).toContain("carrier hangup still pending after 30 ms; closing the session anyway");
    expect(r.session.phase).toBe("finalized");
  });

  test("every hangup or stop waits for the same wrap-up", async () => {
    let release!: () => void;
    const agent: Agent = {
      run: async () => (await new Promise<void>((r) => (release = r)), { toolCalls: [] }),
      summarize: async () => ({ text: "" }),
    };
    const r = await rig({ agent });
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    const first = r.session.stop("caller hung up");
    const second = r.session.hangup("media stream closed");
    expect(second).toBe(first);
    let done = false;
    void second.then(() => (done = true));
    await Bun.sleep(10);
    expect(done).toBe(false); // Luna is still draining
    expect(r.session.phase).toBe("stopping");
    release();
    await second;
    expect(r.session.phase).toBe("finalized");
    expect(r.hangups).toEqual([]); // stop() came first: the phone leg was already gone
  });

  test("duration and cost stop at hangup, not when the wrap-up finishes", async () => {
    let release!: () => void;
    const agent: Agent = {
      run: async () => (await new Promise<void>((r) => (release = r)), { toolCalls: [] }),
      summarize: async () => ({ text: "" }),
    };
    const r = await rig({ agent });
    const ended: Extract<CallEvent, { type: "call.ended" }>[] = [];
    r.bus.subscribe((e) => void (e.type === "call.ended" && ended.push(e)));
    r.config.flow.silence.enabled = false;
    r.advance(10_000);
    r.handlers().onDelegation({ id: "d1" });
    await Bun.sleep(0);
    const stopped = r.session.stop("caller hung up");
    r.advance(20_000); // Luna takes another 20 s
    release();
    await stopped;
    // Live for the 10 s before hangup; this Luna stand-in reports no tokens.
    const cost = (10 / 60) * r.config.cost.live_usd_per_min;
    expect(ended).toHaveLength(1);
    expect(ended[0]!.at).toBe(10_000);
    expect(ended[0]!.endedAt).toBe(1_010_000);
    expect(ended[0]!.costUsd).toBe(Math.round(cost * 10000) / 10000);
    expect(ended[0]!.costs).toMatchObject({ liveSeconds: 10, lunaUsd: 0, jevUsd: 0 });
  });
});

describe("call session: Live usage reports", () => {
  test("every report is stored as an event; a context drop (compaction) is flagged", async () => {
    const r = await rig();
    const usage: unknown[] = [];
    r.bus.subscribe((e) => void (e.type === "live.usage" && usage.push({ seconds: e.seconds, contextRatio: e.contextRatio })));
    r.handlers().onUsage!({ seconds: 60, contextRatio: 0.4 });
    r.handlers().onUsage!({ seconds: 120 }); // context limit unknown this time
    r.handlers().onUsage!({ seconds: 180, contextRatio: 0.92 });
    expect(r.notes.some((n) => n.includes("compacted"))).toBe(false);
    r.handlers().onUsage!({ seconds: 240, contextRatio: 0.07 });
    expect(usage).toEqual([
      { seconds: 60, contextRatio: 0.4 },
      { seconds: 120, contextRatio: undefined },
      { seconds: 180, contextRatio: 0.92 },
      { seconds: 240, contextRatio: 0.07 },
    ]);
    expect(r.notes.at(-1)).toBe(
      "Live context fell from 92% to 7%: it probably compacted older history, and earlier appends may be gone",
    );
    await r.session.stop("test");
  });
});

describe("call session silence watchdog", () => {
  test("prompts after silence, resets on caller speech, hangs up after unanswered prompts", async () => {
    const r = await rig();
    r.advance(6000);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(0);
    r.advance(1500);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(1);

    // Live streams digital silence continuously; that isn't the agent talking.
    r.advance(1000);
    r.handlers().onAudio(b64encode(new Uint8Array(800).fill(0xd5)));
    r.advance(6600);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(2);

    // Real agent speech counts as activity: no prompt while the agent is talking.
    r.handlers().onTranscriptDelta("caller", "x0", "yes?");
    r.handlers().onAudio(b64encode(new Uint8Array(800).fill(0x12)));
    r.advance(5000);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(2);

    // Caller speech resets the prompt count.
    r.handlers().onTranscriptDelta("caller", "x1", "sorry, I'm here");
    r.advance(7500);
    r.advance(7500);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(4);
    expect(r.hangups).toHaveLength(0);
    r.advance(7500); // max_prompts (2) since the caller last spoke → hang up
    expect(r.hangups).toEqual(["cc1"]);
    await r.session.stop("test");
  });

  test("caller speech in the audio holds off the prompt before any transcript arrives", async () => {
    const r = await rig();
    const loud = b64encode(new Uint8Array(160).fill(0xaa)); // 20 ms of loud A-law
    const hiss = b64encode(new Uint8Array(160).fill(0xd4)); // ~-62 dBFS: line noise, not speech
    r.advance(5000);
    r.session.onCallerAudio(loud); // the caller starts talking; Live hasn't transcribed it yet
    r.advance(5000);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(0);
    r.session.onCallerAudio(hiss);
    r.advance(2500); // 7.5 s since the caller's speech: noise doesn't count
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(1);
    await r.session.stop("test");
  });

  test("agent speech counts until it has played out, not when it arrived", async () => {
    const r = await rig();
    r.handlers().onAudio(b64encode(new Uint8Array(3000 * 8).fill(0x12))); // 3 s of speech in one burst
    r.advance(7500); // only 4.5 s since the caller heard the end of it
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(0);
    r.advance(3000);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(1);
    await r.session.stop("test");
  });

  test("a steering instruction restarts the silence timer, so a prompt doesn't pre-empt it", async () => {
    const r = await rig();
    r.advance(6500);
    const steer = (r.session.orch as any).d.steer;
    steer.tellLive({ message: msg("instructions", "SUPERVISOR: ask what the job is"), rev: 0 });
    expect(r.appended).toEqual(["SUPERVISOR: ask what the job is"]);
    r.advance(1000); // 7.5 s since anyone spoke, but only 1 s since the instruction
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(0);
    r.advance(6500);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(1);
    await r.session.stop("test");
  });


  describe("steering instructions are held so they don't cancel the agent", () => {
    const loud = b64encode(new Uint8Array(160).fill(0xaa));
    const speech = (ms: number) => b64encode(new Uint8Array(ms * 8).fill(0x12));
    /** A stage text to hold: Jev says scam → waste_time (held here; the real one is sent at once). */
    const scam = async (r: Awaited<ReturnType<typeof rig>>) => {
      r.config.flow.rules.find((x) => x.stage === "waste_time")!.then!.tell_live!.send = "when_agent_idle";
      (r.session.orch as any).d.classifier = scripted({});
      r.handlers().onTranscriptDelta("caller", "c1", "Hi, it's your bank's fraud team about your account.");
      await r.session.orch.classify();
    };
    const tick = (r: Awaited<ReturnType<typeof rig>>, ms: number) => {
      r.advance(ms);
      r.session.flushHeldInstructions();
    };

    test("while the agent speaks", async () => {
      const r = await rig();
      r.handlers().onAudio(speech(2000));
      await scam(r);
      expect(r.appended).toHaveLength(0);
      tick(r, 2500); // speech over, but Live may just be pausing between phrases
      expect(r.appended).toHaveLength(0);
      tick(r, 600);
      expect(r.appended).toHaveLength(1);
      expect(r.appends).toMatchObject([{ source: "stage", stage: "waste_time", as: r.kinds[0], heldMs: 3100 }]);
      expect(r.appends[0]!.dropped).toBeUndefined();
      await r.session.stop("test");
    });

    test("not in a short pause mid-sentence", async () => {
      const r = await rig();
      r.handlers().onAudio(speech(500));
      await scam(r);
      tick(r, 600); // 100 ms of padding between phrases
      r.handlers().onAudio(b64encode(new Uint8Array(800).fill(0xd5)));
      expect(r.appended).toHaveLength(0);
      r.handlers().onAudio(speech(500)); // the sentence goes on
      tick(r, 1400);
      expect(r.appended).toHaveLength(0);
      tick(r, 200);
      expect(r.appended).toHaveLength(1);
      await r.session.stop("test");
    });

    test("a newer stage replaces one still waiting; other instructions are kept", async () => {
      const r = await rig();
      r.handlers().onAudio(speech(1000));
      const steer = (r.session.orch as any).d.steer;
      steer.tellLive({ message: msg("instructions", "stage A"), key: "stage" });
      steer.tellLive({ message: msg("instructions", "SUPERVISOR: ask for their name"), rev: 0 });
      steer.tellLive({ message: msg("thinking", "stage B"), key: "stage" });
      tick(r, 2100);
      expect(r.appended).toEqual(["SUPERVISOR: ask for their name", "stage B"]);
      expect(r.kinds).toEqual(["instructions", "thinking"]);
      // Each text reaching Live (or replaced before it did) is on the timeline.
      expect(r.appends.map((a) => [a.text, a.heldMs, a.dropped ?? false])).toEqual([
        ["stage A", 0, true],
        ["SUPERVISOR: ask for their name", 2100, false],
        ["stage B", 2100, false],
      ]);
      await r.session.stop("test");
    });

    test("a newer decision drops held guidance, not a held stage; a held delegation still gets an answer", async () => {
      const r = await rig();
      r.handlers().onAudio(speech(1000));
      const steer = (r.session.orch as any).d.steer;
      steer.tellLive({ message: msg("instructions", "waste time"), key: "stage" });
      steer.tellLive({ message: msg("instructions", "SUPERVISOR: ask for their name"), rev: 0 });
      steer.tellLive({ message: msg("instructions", "SUPERVISOR: say he's out"), rev: 0, delegation: { id: "d1", fallback: msg("instructions", FALLBACK) } });
      // e.g. Jev: genuine after all (a Luna rule, so no new stage); a flow decision bumps both
      r.session.orch.revision = r.session.orch.flowRevision = 1;
      tick(r, 2100);
      expect(r.appended).toEqual(["waste time", FALLBACK]);
      expect(r.delegations).toEqual([undefined, "d1"]);
      expect(r.appends.map((a) => [a.text, a.dropped ?? false, a.fallback ?? false])).toEqual([
        ["waste time", false, false],
        ["SUPERVISOR: ask for their name", true, false],
        [FALLBACK, false, true],
      ]);
      await r.session.stop("test");
    });

    test("after the caller speaks, until the agent has replied", async () => {
      const r = await rig();
      r.session.onCallerAudio(loud);
      tick(r, 1000); // Jev's result lands ~1 s after the caller stops: Live is about to reply
      await scam(r);
      tick(r, 500);
      expect(r.appended).toHaveLength(0);
      r.handlers().onAudio(speech(1500)); // the reply
      tick(r, 2000);
      expect(r.appended).toHaveLength(0);
      tick(r, 600); // reply played out (plus the pause allowance)
      expect(r.appended).toHaveLength(1);
      await r.session.stop("test");
    });

    test("sent anyway if the agent doesn't reply within reply_window_ms", async () => {
      const r = await rig();
      r.session.onCallerAudio(loud);
      await scam(r);
      tick(r, 2900);
      expect(r.appended).toHaveLength(0);
      tick(r, 200);
      expect(r.appended).toHaveLength(1);
      await r.session.stop("test");
    });

    test("never longer than max_hold_ms, e.g. constant noise counted as speech", async () => {
      const r = await rig();
      r.session.onCallerAudio(loud);
      await scam(r);
      for (let t = 0; t < 7900; t += 100) {
        r.session.onCallerAudio(loud);
        tick(r, 100);
      }
      expect(r.appended).toHaveLength(0);
      r.session.onCallerAudio(loud);
      tick(r, 200);
      expect(r.appended).toHaveLength(1);
      await r.session.stop("test");
    });

    test("a hangup waits for the agent's goodbye to play out", async () => {
      const r = await rig();
      r.session.onCallerAudio(loud); // "No, just hang up"
      tick(r, 1000);
      const steer = (r.session.orch as any).d.steer;
      let hungUp = false;
      void steer.hangup("the call was ended explicitly").then(() => (hungUp = true));
      r.session.checkPendingHangup();
      expect(r.hangups).toHaveLength(0); // the agent is about to say goodbye
      r.handlers().onAudio(speech(2000)); // "Alright, I'll end the call now. Take care."
      for (let t = 0; t < 2900; t += 100) {
        r.advance(100);
        r.session.checkPendingHangup();
      }
      expect(r.hangups).toHaveLength(0);
      r.advance(200);
      r.session.checkPendingHangup();
      await Bun.sleep(0);
      expect(r.hangups).toEqual(["cc1"]);
      expect(hungUp).toBe(true);
    });

    test("send: now goes out while the agent speaks, replacing an older stage still waiting", async () => {
      const r = await rig();
      r.handlers().onAudio(speech(2000));
      const steer = (r.session.orch as any).d.steer;
      steer.tellLive({ message: msg("instructions", "clarify"), key: "stage" });
      steer.tellLive({ message: msg("instructions", "deflect", { send: "now" }), key: "stage" });
      expect(r.appended).toEqual(["deflect"]);
      tick(r, 4000);
      expect(r.appended).toEqual(["deflect"]);
      await r.session.stop("test");
    });

    test("each held message has its own max_hold_ms; null waits until the agent is idle", async () => {
      const r = await rig();
      const steer = (r.session.orch as any).d.steer;
      r.handlers().onAudio(speech(20_000)); // a long monologue
      steer.tellLive({ message: msg("instructions", "patient", { max_hold_ms: null }) });
      steer.tellLive({ message: msg("instructions", "default") });
      steer.tellLive({ message: msg("instructions", "quick", { max_hold_ms: 1000 }) });
      tick(r, 1000);
      expect(r.appended).toEqual(["quick"]);
      tick(r, 7000);
      expect(r.appended).toEqual(["quick", "default"]);
      tick(r, 12_900); // speech ends at 20 s, plus agent_pause_ms
      expect(r.appended).toEqual(["quick", "default"]);
      tick(r, 200);
      expect(r.appended).toEqual(["quick", "default", "patient"]);
      await r.session.stop("test");
    });

    test("with nothing going on, instructions go straight out", async () => {
      const r = await rig();
      await scam(r);
      expect(r.appended).toHaveLength(1);
      expect(r.notes.some((n) => n.startsWith("sent held"))).toBe(false);
      await r.session.stop("test");
    });
  });

  test("after wrap-up (silence.hang_up_in), silence ends the call instead of prompting", async () => {
    const r = await rig();
    r.session.orch.stage = "wrap_up";
    r.advance(7500);
    expect(r.appended.filter((a) => a === r.prompt)).toHaveLength(0);
    expect(r.hangups).toEqual(["cc1"]);
    await r.session.stop("test");
  });

  test("a stalled media leg is filled with silence so Live keeps running, with one warning", async () => {
    const r = await rig();
    r.stall(100);
    expect(r.sent).toHaveLength(0); // short gaps are normal jitter
    r.stall(300);
    expect(r.sent).toHaveLength(1);
    expect(atob(r.sent[0]!).length).toBe(400 * 8); // 400 ms of PCMA
    expect([...atob(r.sent[0]!)].every((ch) => ch.charCodeAt(0) === 0xd5)).toBe(true);
    for (let i = 0; i < 5; i++) r.stall(300);
    expect(r.notes.filter((n) => n.startsWith("no audio from the caller"))).toHaveLength(1);
    // Real audio resumes: passed through, no filler.
    const before = r.sent.length;
    r.session.onCallerAudio("1111");
    r.stall(100);
    expect(r.sent.slice(before)).toEqual(["1111"]);
    await r.session.stop("test");
  });
});

describe("call session: Live closing the session", () => {
  test("over the Telnyx media stream, it hangs up the phone", async () => {
    const r = await rig();
    r.handlers().onClose("expired");
    expect(r.hangups).toEqual(["cc1"]);
  });
});
