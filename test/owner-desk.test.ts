import { describe, expect, test } from "bun:test";
import type { OwnerSteerResult } from "../src/core/call-session";
import { MemoryEventBus } from "../src/core/event-bus";
import { OwnerDesk } from "../src/core/owner-desk";
import type { LiveAppend } from "../src/core/config";
import type { MessageLayout, OwnerChat } from "../src/core/ports";
import { cls, loadRepoConfig } from "./helpers";

const settle = () => new Promise((r) => setTimeout(r, 5));

async function rig(o: { steer?: (callId: string, text: string, as: LiveAppend) => OwnerSteerResult; canSteer?: boolean; failSends?: number } = {}) {
  const config = await loadRepoConfig();
  config.telegram.status.min_edit_interval_ms = 0;
  let now = 1_000_000;
  let nextId = 100;
  let failed = 0;
  const sent: { id: number; text: string; replyTo?: number; layout?: MessageLayout }[] = [];
  const edits: { id: number; text: string; layout?: MessageLayout }[] = [];
  const steered: { callId: string; text: string; as: LiveAppend }[] = [];
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
      edits.push({ id, text, ...(layout ? { layout } : {}) });
    },
    async answerButton(pressId, notice) {
      answers.push({ pressId, ...(notice ? { notice } : {}) });
    },
  };
  const bus = new MemoryEventBus();
  const desk = new OwnerDesk({
    bus,
    chat,
    config: () => config,
    clock: { now: () => now },
    callLink: (id) => `https://admin.example.com/calls/${id}`,
    canSteer: o.canSteer ?? true,
    steer: (callId, text, as) => {
      steered.push({ callId, text, as });
      return o.steer?.(callId, text, as) ?? { ok: true };
    },
  });
  const start = (callId: string, from = "+441") => bus.publish({ type: "call.started", callId, meta: { callId, from, to: "+442", startedAt: now } });
  const message = (text: string | undefined, replyTo?: number) =>
    desk.onMessage({ messageId: nextId++, date: now, ...(text !== undefined ? { text } : {}), ...(replyTo !== undefined ? { replyTo } : {}) });
  return {
    desk,
    bus,
    config,
    sent,
    edits,
    steered,
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
    expect(r.edits[0]!.layout?.buttons?.[0]?.map((b) => b.label)).toEqual(["Genuine", "Spam/Scam"]);
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
    expect(alerts).toEqual([{ id: alerts[0]!.id, text: "🚨 Urgent call (urgency 0.80): caller: I'm locked out, can you call me?", replyTo: r.sent[0]!.id }]);

    r.start("c2");
    r.bus.publish({ type: "classification", callId: "c2", at: 2000, classification: cls({ verdict: "scam", confidence: 0.8, urgency: 0.95 }) });
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
    r.start("c1");
    await settle();
    const status = r.sent[0]!;
    expect(status.layout?.buttons?.[0]).toEqual([
      { label: "Genuine", data: "steer:0" },
      { label: "Spam/Scam", data: "steer:1" },
    ]);
    await r.desk.onButton({ pressId: "q1", messageId: status.id, data: "steer:0" });
    const genuine = r.config.telegram.steering.buttons[0]!;
    expect(r.steered).toEqual([{ callId: "c1", text: genuine.text, as: genuine.as }]);
    expect(r.answers).toEqual([{ pressId: "q1", notice: `Sent: ${genuine.text}` }]);
    await settle();
    expect(r.lastEdit()).toContain(`${genuine.as}: ${genuine.text}`);

    r.bus.publish({ type: "call.ended", callId: "c1", at: 1, endedAt: 0, reason: "caller hung up", costUsd: 0, lunaCalls: 0, jevTicks: 0 });
    await r.desk.onButton({ pressId: "q2", messageId: status.id, data: "steer:1" });
    expect(r.answers.at(-1)).toEqual({ pressId: "q2", notice: "That call has ended." });
    expect(r.steered).toHaveLength(1);
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
