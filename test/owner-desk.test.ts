import { describe, expect, test } from "bun:test";
import type { OwnerSteerResult } from "../src/core/call-session";
import { MemoryEventBus } from "../src/core/event-bus";
import { OwnerDesk } from "../src/core/owner-desk";
import type { LiveAppend } from "../src/core/config";
import type { MessageLayout, OwnerChat } from "../src/core/ports";
import type { CallMeta } from "../src/core/types";
import { cls, loadRepoConfig } from "./helpers";

const settle = () => new Promise((r) => setTimeout(r, 5));

async function rig(
  o: {
    steer?: (callId: string, text: string, as: LiveAppend) => OwnerSteerResult;
    canSteer?: boolean;
    failSends?: number;
    /** thrown by the next edits, one each */
    editErrors?: Error[];
    accepts?: (meta: CallMeta) => boolean;
    takeoverUrl?: (callId: string) => string | undefined;
    /** shared with another desk (another chat) */
    bus?: MemoryEventBus;
  } = {},
) {
  const config = await loadRepoConfig();
  config.telegram.status.min_edit_interval_ms = 0;
  let now = 1_000_000;
  let nextId = 100;
  let failed = 0;
  const sent: { id: number; text: string; replyTo?: number; layout?: MessageLayout }[] = [];
  const edits: { id: number; text: string; layout?: MessageLayout }[] = [];
  const steered: { callId: string; text: string; as: LiveAppend }[] = [];
  const hungUp: string[] = [];
  const extended: { callId: string; minutes: number }[] = [];
  const staged: { callId: string; stage: string; label: string }[] = [];
  const answers: { pressId: string; notice?: string }[] = [];
  const chat: OwnerChat = {
    async send(text, opts) {
      if (failed < (o.failSends ?? 0)) {
        failed++;
        throw new Error("Telegram sendMessage failed: 502");
      }
      const id = nextId++;
      sent.push({ id, text, ...(opts?.replyTo !== undefined ? { replyTo: opts.replyTo } : {}), ...(opts?.layout ? { layout: opts.layout } : {}) });
      return id;
    },
    async edit(id, text, layout) {
      const err = o.editErrors?.shift();
      if (err) throw err;
      edits.push({ id, text, ...(layout ? { layout } : {}) });
    },
    async answerButton(pressId, notice) {
      answers.push({ pressId, ...(notice ? { notice } : {}) });
    },
  };
  const bus = o.bus ?? new MemoryEventBus();
  const desk = new OwnerDesk({
    bus,
    chat,
    config: () => config,
    clock: { now: () => now },
    callLink: (id) => `https://admin.example.com/calls/${id}`,
    canSteer: o.canSteer ?? true,
    ...(o.accepts ? { accepts: o.accepts } : {}),
    ...(o.takeoverUrl ? { takeoverUrl: o.takeoverUrl } : {}),
    steer: (callId, text, as) => {
      steered.push({ callId, text, as });
      return o.steer?.(callId, text, as) ?? { ok: true };
    },
    enterStage: (callId, stage, label) => (staged.push({ callId, stage, label }), { ok: true }),
    hangUp: (callId) => (hungUp.push(callId), { ok: true }),
    extend: (callId, minutes) => {
      extended.push({ callId, minutes });
      return { ok: true, maxCallSeconds: config.flow.timing.max_call_seconds + 60 * extended.reduce((sum, e) => sum + e.minutes, 0) };
    },
  });
  const start = (callId: string, from = "+441", meta: Partial<CallMeta> = {}) =>
    bus.publish({ type: "call.started", callId, meta: { callId, from, to: "+442", channel: from === "public" ? "public" : "phone", startedAt: now, ...meta } });
  const message = (text: string | undefined, replyTo?: number) =>
    desk.onMessage({ messageId: nextId++, date: now, ...(text !== undefined ? { text } : {}), ...(replyTo !== undefined ? { replyTo } : {}) });
  return {
    desk,
    bus,
    config,
    sent,
    edits,
    steered,
    hungUp,
    extended,
    staged,
    answers,
    start,
    message,
    advance: (ms: number) => void (now += ms),
    lastEdit: () => edits.at(-1)?.text ?? "",
    /** the collapsed part of the last edit */
    lastQuote: () => {
      const e = edits.at(-1);
      const q = e?.layout?.collapsed?.[0];
      return e && q ? e.text.slice(q.offset, q.offset + q.length) : "";
    },
  };
}

describe("owner desk: the call's status message", () => {
  test("sent as the call comes in, then edited with verdict, stage, Luna's progress and the latest lines", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toContain("📞 Incoming call · +441");
    expect(r.sent[0]!.replyTo).toBeUndefined();

    r.advance(12_000);
    r.bus.publish({ type: "transcript", callId: "c1", entry: { seq: 1, speaker: "caller", text: "Hi, it's the bank.", at: 1000, final: true } });
    r.bus.publish({ type: "classification", callId: "c1", at: 2000, classification: cls({ verdict: "scam", confidence: 0.92, urgency: 0.1 }) });
    r.bus.publish({ type: "stage", callId: "c1", at: 2000, stage: "waste_time" });
    r.bus.publish({ type: "progress", callId: "c1", at: 3000, summary: "Claims to be the bank.", questions: ["Is Peter home?"], reason: "test", tookMs: 1 });
    await settle();
    // One edit for the lot.
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.id).toBe(r.sent[0]!.id);
    const text = r.lastEdit();
    expect(text).toContain("0:12");
    expect(text).toContain("scam 92%");
    expect(text).toContain("stage: waste time");
    expect(text).toContain("📝 Claims to be the bank.");
    expect(text).toContain("❓ Is Peter home?");
    expect(r.lastQuote()).toBe("0:01 caller: Hi, it's the bank.");
    expect(text).toContain("Reply to steer");
    expect(r.edits[0]!.layout?.buttons?.[0]?.map((b) => b.label)).toEqual(["Genuine", "Scam", "Spam", "+5 min", "Hang up"]);
    expect(text).toContain("https://admin.example.com/calls/c1");
  });

  test("edits wait min_edit_interval_ms after the last one", async () => {
    const r = await rig();
    r.config.telegram.status.min_edit_interval_ms = 60_000;
    r.start("c1");
    r.bus.publish({ type: "stage", callId: "c1", at: 1, stage: "clarify" });
    await settle();
    expect(r.edits).toHaveLength(0);
    // Shutdown sends it anyway.
    await r.desk.flush();
    expect(r.lastEdit()).toContain("stage: clarify");
    r.desk.detach();
  });

  test("at the end: ended, Luna's summary in place of the rolling one, steering kept, no live parts", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    r.bus.publish({ type: "transcript", callId: "c1", entry: { seq: 1, speaker: "caller", text: "It's Sarah.", at: 1000, final: true } });
    r.bus.publish({ type: "progress", callId: "c1", at: 3000, summary: "Sarah is calling.", questions: [], reason: "test", tookMs: 1 });
    await r.message("ask for her number");
    r.bus.publish({ type: "call.ended", callId: "c1", at: 65_000, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    r.bus.publish({ type: "summary", callId: "c1", at: 70_000, text: "Sarah wants a call back on 0207 946 0000." });
    const costs = { liveSeconds: 65, liveUsd: 0.054, lunaUsd: 0.002, jevUsd: 0.001, totalUsd: 0.057, luna: { calls: 2, inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 }, jevInputTokens: 1 };
    r.bus.publish({ type: "costs", callId: "c1", at: 70_000, costs });
    await settle();
    const text = r.lastEdit();
    expect(text).toContain("✅ Call ended · +441 · 1:05 · caller hung up");
    expect(text).toContain("📝 Sarah wants a call back");
    expect(text).not.toContain("Sarah is calling.");
    expect(text).toContain("🗣 Your steering\n0:00 commentary: ask for her number");
    // The transcript stays; the buttons and the steering hint go.
    expect(r.lastQuote()).toBe("0:01 caller: It's Sarah.");
    expect(text).toContain("💰 $0.057 (Live $0.054 · Luna $0.002 · Jev $0.001)");
    expect(text).not.toContain("Reply to steer");
    expect(r.edits.at(-1)!.layout?.buttons).toBeUndefined();
    r.desk.detach();
  });

  test("the transcript is newest first; what doesn't fit is left to the call page", async () => {
    const r = await rig();
    r.start("c1");
    for (let seq = 1; seq <= 40; seq++) {
      r.bus.publish({ type: "transcript", callId: "c1", entry: { seq, speaker: seq % 2 ? "caller" : "agent", text: `line ${seq} ` + "x".repeat(200), at: seq * 1000, final: true } });
    }
    await settle();
    const quote = r.lastQuote();
    expect(quote.startsWith("0:40 agent: line 40")).toBe(true);
    expect(quote.endsWith("… earlier lines on the call page")).toBe(true);
    expect(quote).not.toContain("line 1 ");
    expect(r.lastEdit().length).toBeLessThanOrEqual(4096);
  });

  test("an urgent call gets one notifying reply, not a scam that sounds urgent", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    r.bus.publish({ type: "transcript", callId: "c1", entry: { seq: 1, speaker: "caller", text: "I'm locked out, can you call me?", at: 1000, final: true } });
    r.bus.publish({ type: "classification", callId: "c1", at: 2000, classification: cls({ verdict: "genuine", confidence: 0.6, urgency: 0.8 }) });
    r.bus.publish({ type: "classification", callId: "c1", at: 3000, classification: cls({ verdict: "genuine", confidence: 0.7, urgency: 0.9 }) });
    await settle();
    const alerts = r.sent.filter((m) => m.text.startsWith("🚨"));
    // 0.8 is under min_urgency (0.85); 0.9 alerts.
    expect(alerts).toEqual([{ id: alerts[0]!.id, text: "🚨 Urgent call (urgency 0.90): caller: I'm locked out, can you call me?", replyTo: r.sent[0]!.id }]);

    r.start("c2");
    r.bus.publish({ type: "classification", callId: "c2", at: 2000, classification: cls({ verdict: "scam", confidence: 0.8, urgency: 0.95 }) });
    // A bank "fraud team" caller: scam 0.54 and urgency 0.91 at their first words.
    r.start("c3");
    r.bus.publish({ type: "classification", callId: "c3", at: 2000, classification: cls({ verdict: "scam", confidence: 0.54, urgency: 0.91 }) });
    await settle();
    expect(r.sent.filter((m) => m.text.startsWith("🚨"))).toHaveLength(1);
    r.desk.detach();
  });

  test("Luna's summary can alert too, once per call", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    const progress = (alert: boolean) =>
      r.bus.publish({ type: "progress", callId: "c1", at: 3000, summary: "Viktor says he's at the door.", questions: [], alert, reason: "test", tookMs: 1 });
    progress(false);
    progress(true);
    progress(true);
    r.bus.publish({ type: "classification", callId: "c1", at: 4000, classification: cls({ verdict: "genuine", confidence: 0.7, urgency: 0.9 }) });
    await settle();
    expect(r.sent.filter((m) => m.text.startsWith("🚨")).map((m) => m.text)).toEqual(["🚨 Urgent call (Luna): Viktor says he's at the door."]);
    r.desk.detach();
  });

  test("if the first send fails, the status message is sent again, then edited", async () => {
    const r = await rig({ failSends: 1 });
    r.start("c1");
    await settle();
    // Retried after min_edit_interval_ms, without waiting for news.
    await settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toContain("📞 Incoming call");
    r.bus.publish({ type: "stage", callId: "c1", at: 1, stage: "genuine" });
    await settle();
    expect(r.edits).toEqual([expect.objectContaining({ id: r.sent[0]!.id })]);
    expect(r.lastEdit()).toContain("stage: genuine");
  });

  test("nothing is sent when status messages are off", async () => {
    const r = await rig();
    r.config.telegram.status.enabled = false;
    r.start("c1");
    await settle();
    expect(r.sent).toEqual([]);
  });
});

describe("owner desk: the chat's message budget", () => {
  const stage = (r: Awaited<ReturnType<typeof rig>>, callId: string, s: string) => r.bus.publish({ type: "stage", callId, at: 1, stage: s });

  test("max_messages_per_minute is shared by the chat's calls: due edits wait their turn, ended calls first", async () => {
    const r = await rig();
    r.config.telegram.status.max_messages_per_minute = 4;
    r.start("c1");
    r.start("c2");
    r.start("c3");
    await settle();
    expect(r.sent).toHaveLength(3);
    stage(r, "c1", "clarify");
    stage(r, "c2", "clarify");
    await settle();
    // One slot left: c1's edit takes it, c2's waits.
    expect(r.edits.map((e) => e.id)).toEqual([100]);
    r.bus.publish({ type: "call.ended", callId: "c3", at: 5000, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await settle();
    expect(r.edits).toHaveLength(1);
    // A minute on, the ended call's final edit goes before c2's.
    r.advance(60_000);
    stage(r, "c2", "genuine");
    await settle();
    expect(r.edits.map((e) => e.id)).toEqual([100, 102, 101]);
    expect(r.edits[1]!.text).toContain("✅ Call ended");
    expect(r.lastEdit()).toContain("stage: genuine");
  });

  test("an edit that changes nothing gives its slot back to the next waiting one", async () => {
    const r = await rig();
    r.config.telegram.status.max_messages_per_minute = 2;
    r.start("c1");
    await settle();
    r.bus.publish({ type: "call.ended", callId: "c1", at: 5000, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await settle();
    r.start("c2");
    await settle();
    // c1's update has nothing to show (an ended call's message hides it); both wait.
    r.bus.publish({ type: "takeover.live", callId: "c1", at: 1 });
    stage(r, "c2", "clarify");
    await settle();
    r.advance(30_000);
    r.start("c3");
    await settle();
    // A minute on there's room for one: c1 takes it, finds nothing to send, and hands it to c2.
    r.advance(30_000);
    r.bus.publish({ type: "takeover.live", callId: "c3", at: 1 });
    await settle();
    expect(r.edits.map((e) => e.id)).toEqual([100, 101]);
  });

  test("a call that ends while its edit waits moves ahead of live calls", async () => {
    const r = await rig();
    r.config.telegram.status.max_messages_per_minute = 3;
    r.start("c1");
    r.start("c2");
    r.start("c3");
    await settle();
    stage(r, "c1", "clarify");
    stage(r, "c2", "clarify");
    await settle();
    expect(r.edits).toEqual([]);
    r.bus.publish({ type: "call.ended", callId: "c2", at: 5000, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await settle();
    r.advance(60_000);
    stage(r, "c1", "genuine");
    await settle();
    expect(r.edits.map((e) => e.id)).toEqual([101, 100]);
  });

  test("a 429 holds the chat's edits for retry_after, then the failed edit goes again", async () => {
    const tooFast = Object.assign(new Error("Telegram editMessageText failed: 429 Too Many Requests"), { retryAfterMs: 5000 });
    const r = await rig({ editErrors: [tooFast] });
    r.start("c1");
    r.start("c2");
    await settle();
    stage(r, "c1", "clarify");
    await settle();
    expect(r.edits).toEqual([]);
    stage(r, "c2", "clarify");
    await settle();
    expect(r.edits).toEqual([]);
    r.advance(5000);
    stage(r, "c2", "genuine");
    await settle();
    expect(r.edits.map((e) => e.id).sort()).toEqual([100, 101]);
    expect(r.edits.find((e) => e.id === 100)!.text).toContain("stage: clarify");
  });

  test("without status.transcript, lines don't edit the message or show in it", async () => {
    const r = await rig();
    r.config.telegram.status.transcript = false;
    r.start("c1");
    await settle();
    r.bus.publish({ type: "transcript", callId: "c1", entry: { seq: 1, speaker: "caller", text: "Hi, it's the bank.", at: 1000, final: true } });
    await settle();
    expect(r.edits).toEqual([]);
    stage(r, "c1", "waste_time");
    await settle();
    expect(r.lastEdit()).toContain("stage: waste time");
    expect(r.lastEdit()).not.toContain("Transcript");
    expect(r.lastEdit()).not.toContain("the bank");
  });
});

describe("owner desk: steering", () => {
  test("a reply steers that call; a plain message steers the newest live call", async () => {
    const r = await rig();
    r.start("c1");
    r.advance(1000);
    r.start("c2");
    await settle();
    const [s1] = r.sent;
    await r.message("hold on", s1!.id);
    await r.message("keep going");
    expect(r.steered).toEqual([
      { callId: "c1", text: "hold on", as: "commentary" },
      { callId: "c2", text: "keep going", as: "commentary" },
    ]);
    await settle();
    expect(r.edits.find((e) => e.id === s1!.id)?.text).toContain("commentary: hold on");
  });

  test("a prefix picks instructions or thinking, and is removed", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    await r.message("! stop, don't give that");
    await r.message("~keep them talking");
    expect(r.steered).toEqual([
      { callId: "c1", text: "stop, don't give that", as: "instructions" },
      { callId: "c1", text: "keep them talking", as: "thinking" },
    ]);
    // A reply says how each went out, so a silent one isn't a surprise.
    expect(r.sent.slice(1).map((m) => m.text.split(":")[0])).toEqual(["Sent as instructions", "Sent as thinking"]);
    expect(r.sent.at(-1)!.text).toContain("isn't spoken now");
  });

  test("below the call flow's threshold, the verdict is only leaning", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    r.bus.publish({ type: "classification", callId: "c1", at: 2000, classification: cls({ verdict: "scam", confidence: 0.62 }) });
    await settle();
    expect(r.lastEdit()).toContain("leaning scam 62%");
    r.bus.publish({ type: "classification", callId: "c1", at: 3000, classification: cls({ verdict: "scam", confidence: 0.81 }) });
    await settle();
    expect(r.lastEdit()).toContain("\nscam 81%");
    r.bus.publish({ type: "classification", callId: "c1", at: 4000, classification: cls({ verdict: "unclear", confidence: 0.6 }) });
    await settle();
    expect(r.lastEdit()).toContain("\nunclear 60%");
  });

  test("says why a message couldn't steer anything", async () => {
    const r = await rig({ steer: () => ({ ok: false, reason: "the call isn't connected yet" }) });
    await r.message("hello");
    expect(r.sent.at(-1)!.text).toBe("No call in progress.");

    r.start("c1");
    await settle();
    const status = r.sent.at(-1)!.id;
    await r.message("hello", 5);
    expect(r.sent.at(-1)!.text).toContain("I can't tell which call");
    await r.message(undefined);
    expect(r.sent.at(-1)!.text).toBe("Only text messages can steer a call.");
    await r.message("hello");
    expect(r.sent.at(-1)!.text).toBe("Not sent: the call isn't connected yet.");

    r.bus.publish({ type: "call.ended", callId: "c1", at: 1, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await r.message("hello", status);
    expect(r.sent.at(-1)!.text).toBe("That call has ended.");
    r.desk.detach();
  });

  test("/help explains steering; old messages are ignored", async () => {
    const r = await rig();
    await r.message("/start");
    expect(r.sent.at(-1)!.text).toContain("! → instructions");
    const before = r.sent.length;
    await r.desk.onMessage({ messageId: 1, text: "from yesterday", date: 0 });
    expect(r.sent).toHaveLength(before);
  });

  test("a button sends its text to that call, as its kind", async () => {
    const r = await rig();
    r.config.telegram.steering.buttons = [{ label: "Ask", text: "Ask what it's about.", as: "commentary", hang_up: false }];
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    expect(status.layout?.buttons?.[0]).toEqual([{ label: "Ask", data: "steer:0" }]);
    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: "steer:0" });
    expect(r.steered).toEqual([{ callId: "c1", text: "Ask what it's about.", as: "commentary" }]);
    expect(r.answers).toEqual([{ pressId: "q1", notice: "Sent: Ask what it's about." }]);
    await settle();
    expect(r.lastEdit()).toContain("commentary: Ask what it's about.");

    r.bus.publish({ type: "call.ended", callId: "c1", at: 1, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await r.desk.onButton({ pressId: "q2", messageId: status.id, data: "steer:0" });
    expect(r.answers.at(-1)).toEqual({ pressId: "q2", notice: "That call has ended." });
    expect(r.steered).toHaveLength(1);
    r.desk.detach();
  });

  test("a stage button moves that call into its call-flow stage", async () => {
    const r = await rig();
    r.config.telegram.steering.buttons = [{ label: "Scam", stage: "waste_time" }];
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: "steer:0" });
    expect(r.staged).toEqual([{ callId: "c1", stage: "waste_time", label: "Scam" }]);
    expect(r.steered).toEqual([]);
    expect(r.answers).toEqual([{ pressId: "q1", notice: "Sent: Scam" }]);
    await settle();
    const as = r.config.flow.rules.find((x) => x.stage === "waste_time")!.then!.tell_live!.as;
    expect(r.lastEdit()).toContain(`${as}: Scam (stage: waste time)`);
    r.desk.detach();
  });

  test("the extend button adds time to that call, and the status message shows the new limit", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    const i = r.config.telegram.steering.buttons.findIndex((b) => "extend_minutes" in b);
    const max = r.config.flow.timing.max_call_seconds;
    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: `steer:${i}` });
    await r.desk.onButton({ pressId: "q2", messageId: status.id, data: `steer:${i}` });
    expect(r.extended).toEqual([{ callId: "c1", minutes: 5 }, { callId: "c1", minutes: 5 }]);
    expect(r.steered).toEqual([]);
    expect(r.answers.at(-1)).toEqual({ pressId: "q2", notice: `Added 5 min: the call can run ${(max + 600) / 60}:00.` });
    await settle();
    expect(r.lastEdit()).toContain(`0:00 of ${(max + 600) / 60}:00`);
    r.desk.detach();
  });

  test("Hang up (button or /hangup): the goodbye goes to Live, then the call hangs up", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    const goodbye = r.config.telegram.steering.buttons.find((b) => "hang_up" in b && b.hang_up)!;
    if (!("text" in goodbye)) throw new Error("no hang_up button");
    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: `steer:${r.config.telegram.steering.buttons.indexOf(goodbye)}` });
    expect(r.steered).toEqual([{ callId: "c1", text: goodbye.text, as: goodbye.as }]);
    expect(r.hungUp).toEqual(["c1"]);
    expect(r.answers).toEqual([{ pressId: "q1", notice: "Hanging up after the goodbye." }]);

    await r.message("/hangup", status.id);
    expect(r.hungUp).toEqual(["c1", "c1"]);
    expect(r.sent.at(-1)!.text).toBe("Hanging up after the goodbye.");
    r.desk.detach();
  });

  test("Luna's suggestions are buttons, one per row; a replaced one still sends what it showed", async () => {
    const r = await rig();
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    const progress = (suggestions: { label: string; text: string }[]) =>
      r.bus.publish({ type: "progress", callId: "c1", at: 3000, summary: "Sarah is calling.", questions: [], suggestions, reason: "test", tookMs: 1 });
    const first = [
      { label: "Call back soon", text: "Tell her you'll call back as soon as you can." },
      { label: "Ask what it's about", text: "Ask what it's about." },
    ];
    progress(first);
    await settle();
    expect(r.edits.at(-1)!.layout?.buttons?.slice(1)).toEqual([
      [{ label: "Call back soon", data: "sug:1:0" }],
      [{ label: "Ask what it's about", data: "sug:1:1" }],
    ]);
    // The same suggestions again keep their buttons; new ones replace them.
    progress(first);
    progress([{ label: "Wrap up", text: "Thank her and say goodbye." }]);
    await settle();
    expect(r.edits.at(-1)!.layout?.buttons?.slice(1)).toEqual([[{ label: "Wrap up", data: "sug:2:0" }]]);

    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: "sug:1:0" });
    await r.desk.onButton({ pressId: "q2", messageId: status.id, data: "sug:2:0" });
    await r.desk.onButton({ pressId: "q3", messageId: status.id, data: "sug:9:0" });
    const as = r.config.telegram.steering.suggestions.as;
    expect(r.steered).toEqual([
      { callId: "c1", text: first[0]!.text, as },
      { callId: "c1", text: "Thank her and say goodbye.", as },
    ]);
    expect(r.answers.at(-1)).toEqual({ pressId: "q3", notice: "That button no longer does anything." });

    r.config.telegram.steering.suggestions.enabled = false;
    r.bus.publish({ type: "stage", callId: "c1", at: 4000, stage: "genuine" });
    await settle();
    expect(r.edits.at(-1)!.layout?.buttons).toHaveLength(1);
    r.desk.detach();
  });

  test("without a chat to hear from, there's no steering", async () => {
    const r = await rig({ canSteer: false });
    r.start("c1");
    await settle();
    expect(r.sent[0]!.text).not.toContain("Reply to steer");
    await r.message("hello");
    expect(r.steered).toEqual([]);
  });
});

describe("owner desk: a chat of its own for some calls", () => {
  const isPublic = (m: CallMeta) => m.channel === "public";

  test("a desk ignores the calls it doesn't take", async () => {
    const r = await rig({ accepts: isPublic });
    r.start("phone", "+441");
    await settle();
    expect(r.sent).toEqual([]);
    r.bus.publish({ type: "stage", callId: "phone", at: 1, stage: "clarify" });
    await settle();
    expect(r.edits).toEqual([]);
    await r.message("hello", 5);
    expect(r.sent.at(-1)!.text).toContain("I can't tell which call");
    await r.message("hello");
    expect(r.sent.at(-1)!.text).toBe("No call in progress.");
    expect(r.steered).toEqual([]);
  });

  test("two chats on one bus, with the same message ids: each steers only its own calls", async () => {
    const main = await rig({ accepts: (m) => !isPublic(m) });
    const pub = await rig({ accepts: isPublic, bus: main.bus });
    pub.start("game", "public");
    await settle();
    main.advance(1000);
    pub.advance(1000);
    main.start("phone", "+441");
    await settle();
    expect(main.sent).toHaveLength(1);
    expect(main.sent[0]!.text).toContain("+441");
    expect(pub.sent).toHaveLength(1);
    expect(pub.sent[0]!.text).toContain("public");
    // Telegram numbers messages per chat: both status messages have id 100.
    expect(main.sent[0]!.id).toBe(100);
    expect(pub.sent[0]!.id).toBe(100);

    await main.message("hold on", 100);
    await pub.message("say you're a pirate", 100);
    // A plain message in the public chat steers the newest public call, though the phone call came later.
    await pub.message("keep going");
    expect(main.steered).toEqual([{ callId: "phone", text: "hold on", as: "commentary" }]);
    expect(pub.steered).toEqual([
      { callId: "game", text: "say you're a pirate", as: "commentary" },
      { callId: "game", text: "keep going", as: "commentary" },
    ]);
  });
});

describe("owner desk: declined calls", () => {
  test("a call a limit turned away gets one notifying line, with no buttons and no edits", async () => {
    const r = await rig();
    r.start("d1", "+447700900123", { declined: "declined: daily spend reached ($20.10 of $20 in 24 h)" });
    r.bus.publish({ type: "call.ended", callId: "d1", at: 0, endedAt: 1, reason: "declined: daily spend reached", endedBy: "system", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toContain("+447700900123");
    expect(r.sent[0]!.text).toContain("https://admin.example.com/calls/d1");
    expect(r.sent[0]!.layout).toBeUndefined();
    expect(r.sent[0]!.replyTo).toBeUndefined();
    r.advance(60_000);
    await settle();
    expect(r.edits).toEqual([]);
  });
});

describe("owner desk: recording failures", () => {
  test("a stopped recording gets a notifying reply under the status message; public calls don't", async () => {
    const r = await rig();
    r.start("c1");
    r.start("p1", "+441", { channel: "public" });
    await settle();
    const status = r.sent.length;
    r.bus.publish({ type: "recording.failed", callId: "c1", at: 65_000, reason: "recording stopped: writing it failed" });
    r.bus.publish({ type: "recording.failed", callId: "p1", at: 1_000, reason: "recording stopped: writing it failed" });
    await settle();
    expect(r.sent.slice(status).map((m) => m.text)).toEqual(["⚠️ Recording stopped: writing it failed (at 1:05)."]);
    expect(r.sent.at(-1)!.replyTo).toBe(r.sent[0]!.id);
  });
});

describe("owner desk: takeover", () => {
  const url = (id: string) => `https://hooks.example.com/takeover/${id}`;
  async function takeoverRig(o: Parameters<typeof rig>[0] = {}) {
    const r = await rig({ takeoverUrl: url, ...o });
    r.config.telegram.takeover.enabled = true;
    return r;
  }
  const takeoverRow = (layout?: MessageLayout) => layout?.buttons?.find((row) => row.some((b) => b.webApp !== undefined));

  test("a live phone call's status message has a Take over button opening the takeover page", async () => {
    const r = await takeoverRig();
    r.start("c1");
    await settle();
    expect(takeoverRow(r.sent[0]!.layout)).toEqual([{ label: r.config.telegram.takeover.button_label, webApp: url("c1") }]);
    // The steering buttons are still there.
    expect(r.sent[0]!.layout?.buttons?.some((row) => row.some((b) => b.data?.startsWith("steer:")))).toBe(true);
  });

  test("no button for other channels, when turned off, or without a takeover URL", async () => {
    const r = await takeoverRig();
    r.start("p1", "public");
    r.start("t1", "+441", { channel: "test" });
    await settle();
    r.config.telegram.takeover.enabled = false;
    r.start("c1");
    await settle();
    for (const m of r.sent) expect(takeoverRow(m.layout)).toBeUndefined();

    const none = await takeoverRig({ takeoverUrl: () => undefined });
    none.start("c2");
    await settle();
    expect(takeoverRow(none.sent[0]!.layout)).toBeUndefined();
  });

  test("taken over: the message says so, the buttons go, steering is off, /hangup hangs up at once", async () => {
    const r = await takeoverRig();
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    r.advance(65_000);
    r.bus.publish({ type: "takeover.started", callId: "c1", at: 65_000 });
    await settle();
    expect(r.lastEdit()).toContain("🎧 You took over · +441");
    expect(r.lastEdit()).toContain("You took over at 1:05 (connecting…): steering is off");
    r.bus.publish({ type: "takeover.live", callId: "c1", at: 67_000 });
    await settle();
    expect(r.lastEdit()).toContain("You took over at 1:05: steering is off");
    expect(r.lastEdit()).not.toContain("Reply to steer");
    expect(r.edits.at(-1)!.layout?.buttons).toBeUndefined();

    await r.message("say hi", status.id);
    expect(r.steered).toEqual([]);
    expect(r.sent.at(-1)!.text).toBe("You took this call over: steering is off.");
    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: "steer:0" });
    expect(r.answers.at(-1)).toEqual({ pressId: "q1", notice: "You took this call over: steering is off." });
    expect(r.steered).toEqual([]);
    await r.message("/hangup", status.id);
    expect(r.hungUp).toEqual(["c1"]);
    expect(r.steered).toEqual([]);
    expect(r.sent.at(-1)!.text).toBe("Hanging up.");

    r.bus.publish({ type: "call.ended", callId: "c1", at: 90_000, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await settle();
    expect(r.lastEdit()).toContain("✅ Call ended");
    expect(r.lastEdit()).toContain("🎧 You took over at 1:05");
    expect(r.lastEdit()).not.toContain("steering is off");
    expect(r.edits.at(-1)!.layout?.buttons).toBeUndefined();
  });

  test("a failed takeover brings the button back and says why", async () => {
    const r = await takeoverRig();
    r.start("c1");
    r.bus.publish({ type: "takeover.started", callId: "c1", at: 1000 });
    await settle();
    r.bus.publish({ type: "takeover.failed", callId: "c1", at: 2000, reason: "the refer was refused" });
    await settle();
    expect(r.lastEdit()).toContain("⚠️ Takeover failed: the refer was refused");
    expect(r.lastEdit()).toContain("📞 Incoming call");
    expect(takeoverRow(r.edits.at(-1)!.layout)).toEqual([{ label: r.config.telegram.takeover.button_label, webApp: url("c1") }]);
  });

  test("an ended call has no button", async () => {
    const r = await takeoverRig();
    r.start("c1");
    r.bus.publish({ type: "call.ended", callId: "c1", at: 5000, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await settle();
    expect(takeoverRow(r.edits.at(-1)!.layout)).toBeUndefined();
  });
});
