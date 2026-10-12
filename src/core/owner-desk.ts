import type { AppConfig, LiveAppend, TelegramConfig } from "./config";
import type { OwnerExtendResult, OwnerSteerResult } from "./call-session";
import { describeCosts } from "./cost";
import { logger } from "./log";
import type { Clock, EventBus, MessageLayout, OwnerButtonPress, OwnerChat, OwnerMessage } from "./ports";
import type { CallCosts, CallEvent, Suggestion, Verdict } from "./types";

const log = logger("owner");

// The owner's chat (Telegram, telegram.yaml): one status message per call, sent as the call
// comes in and edited as it goes on, and the owner's messages back, which steer the call. A reply
// to any message about a call steers that call; any other message steers the newest live call.
// Buttons under a live call's status message send telegram.yaml steering.buttons texts or move the
// call into a call-flow stage, and Luna's suggestions from her latest rolling summary
// (steering.suggestions).

export interface OwnerDeskDeps {
  bus: EventBus;
  chat: OwnerChat;
  config: () => AppConfig;
  clock: Clock;
  /** the call's page on the admin UI, linked from its status message */
  callLink?: (callId: string) => string;
  /** sends the owner's message to the call's Live session (CallSession.steerFromOwner) */
  steer: (callId: string, text: string, as: LiveAppend) => OwnerSteerResult;
  /** moves the call into a call-flow stage, sending its tell_live (CallSession.stageFromOwner) */
  enterStage: (callId: string, stage: string, label: string) => OwnerSteerResult;
  /** ends the call once the agent's goodbye has played (CallSession.hangUpFromOwner) */
  hangUp: (callId: string) => OwnerSteerResult;
  /** lets the call run `minutes` longer (CallSession.extendFromOwner) */
  extend: (callId: string, minutes: number) => OwnerExtendResult;
  /** whether steering is possible at all (it needs a chat we can hear from) */
  canSteer: boolean;
}

/** Telegram's limit for a message's text */
const MAX_CHARS = 4096;
/** status messages kept for editing this long after the call ends (Luna's summary comes later) */
const KEEP_ENDED_MS = 10 * 60_000;
/** message ids → call, for replies (most recent kept) */
const MAX_TRACKED_MESSAGES = 1000;
const MAX_STEERS_SHOWN = 10;
const MAX_LINE_CHARS = 300;
/** a suggestion's button label (Telegram cuts long ones off on phones) */
const MAX_LABEL_CHARS = 40;
/** a status message button's data: "steer:<index in steering.buttons>" */
const BUTTON = "steer:";
/** a suggestion button's data: "sug:<generation>:<index>" */
const SUGGESTION = "sug:";
/** suggestion generations kept, so a tap on buttons just replaced still sends what it showed */
const KEEP_SUGGESTION_GENERATIONS = 3;
/** what each kind does to the agent (call-flow.yaml tell_live), for the owner */
const AS_EFFECT: Record<LiveAppend, string> = {
  commentary: "the agent acts on it now, in its own words",
  thinking: "silent, it shapes later replies but isn't spoken now",
  instructions: "it cuts the agent off and redirects it",
};

interface CallView {
  callId: string;
  from: string;
  startedAt: number;
  /** resolves to the status message's id, or null if it couldn't be sent */
  message: Promise<number | null>;
  verdict?: { verdict: Verdict; confidence: number; urgency: number };
  stage?: string;
  progress?: { summary: string; questions: string[] };
  /** Luna's suggestions, newest last; a generation is shown until the next replaces it */
  suggestions: { gen: number; items: Suggestion[] }[];
  summary?: string;
  steers: { at: number; as: LiveAppend; text: string }[];
  /** final utterances by seq */
  lines: Map<number, { speaker: string; text: string; at: number }>;
  ended?: { reason: string; at: number };
  costs?: CallCosts;
  /** the call's length limit (ms), once the owner has extended it */
  limitMs?: number;
  /** what the message shows now (text and layout, after the last edit) */
  shown: string;
  lastEditAt: number;
  editTimer: ReturnType<typeof setTimeout> | null;
  /** the urgent alert went out (telegram.yaml status.urgent_alert) */
  alerted?: boolean;
  /** forgets the call once its status message is final */
  dropTimer?: ReturnType<typeof setTimeout>;
  /** the edit in flight; the next waits for it */
  editing: Promise<void>;
}

export class OwnerDesk {
  private views = new Map<string, CallView>();
  /** status messages, Luna's messages and replies about a call → the call */
  private messages = new Map<number, string>();
  private unsubscribe: () => void;

  constructor(private d: OwnerDeskDeps) {
    this.unsubscribe = d.bus.subscribe((ev) => this.onEvent(ev));
  }

  /** Sends a message about a call, so replies to it steer that call. */
  private async sendFor(callId: string, text: string, opts: Parameters<OwnerChat["send"]>[1]): Promise<number> {
    const id = await this.d.chat.send(text, opts);
    this.track(id, callId);
    return id;
  }

  /** Whether calls get status messages (telegram.yaml status.enabled). */
  get showsStatus(): boolean {
    return this.d.config().telegram.status.enabled;
  }

  private track(messageId: number, callId: string) {
    this.messages.set(messageId, callId);
    if (this.messages.size > MAX_TRACKED_MESSAGES) this.messages.delete(this.messages.keys().next().value!);
  }

  private onEvent(ev: CallEvent) {
    if (ev.type === "call.started") return this.open(ev.callId, ev.meta.from, ev.meta.startedAt);
    const v = this.views.get(ev.callId);
    if (!v) return;
    switch (ev.type) {
      case "classification":
        v.verdict = { verdict: ev.classification.verdict, confidence: ev.classification.confidence, urgency: ev.classification.urgency };
        this.alertIfUrgent(v, ev.classification.answers.verdict?.probabilities);
        break;
      case "stage":
        v.stage = ev.stage;
        break;
      case "progress":
        v.progress = { summary: ev.summary, questions: ev.questions };
        this.setSuggestions(v, ev.suggestions ?? []);
        if (ev.alert && this.d.config().telegram.status.urgent_alert.luna) this.alert(v, "Luna");
        break;
      case "transcript":
        if (!ev.entry.final || !ev.entry.text) return;
        v.lines.set(ev.entry.seq, { speaker: ev.entry.speaker, text: ev.entry.text, at: ev.entry.at });
        break;
      case "call.ended":
        v.ended = { reason: ev.reason, at: ev.at };
        if (ev.costs) v.costs = ev.costs;
        v.dropTimer ??= setTimeout(() => this.views.delete(v.callId), KEEP_ENDED_MS);
        break;
      case "costs":
        v.costs = ev.costs;
        break;
      case "summary":
        v.summary = ev.text;
        break;
      default:
        return;
    }
    this.schedule(v);
  }

  /** A new generation of Luna's suggestions, unless they're the ones shown already. */
  private setSuggestions(v: CallView, items: Suggestion[]) {
    const last = v.suggestions.at(-1);
    if (JSON.stringify(last?.items ?? []) === JSON.stringify(items)) return;
    v.suggestions.push({ gen: (last?.gen ?? 0) + 1, items });
    if (v.suggestions.length > KEEP_SUGGESTION_GENERATIONS) v.suggestions.shift();
  }

  /** Jev says the call is urgent (status.urgent_alert), unless it's likely junk. */
  private alertIfUrgent(v: CallView, verdict: Record<string, number> | undefined) {
    const a = this.d.config().telegram.status.urgent_alert;
    const c = v.verdict;
    if (!c || c.urgency < a.min_urgency) return;
    if ((verdict?.scam ?? 0) + (verdict?.spam ?? 0) >= a.unless_junk) return;
    this.alert(v, `urgency ${c.urgency.toFixed(2)}`);
  }

  /**
   * Status edits don't notify: an urgent call gets one reply that does (status.urgent_alert),
   * with the latest summary, or the caller's last words before there is one.
   */
  private alert(v: CallView, why: string) {
    if (!this.d.config().telegram.status.urgent_alert.enabled || v.alerted || v.ended) return;
    v.alerted = true;
    const lastCaller = [...v.lines.entries()].sort((x, y) => y[0] - x[0]).find(([, l]) => l.speaker === "caller")?.[1].text;
    const about = v.progress?.summary ?? (lastCaller ? `caller: ${lastCaller}` : "");
    const text = `🚨 Urgent call (${why})${about ? `: ${cut(about, 600)}` : ""}`;
    void v.message
      .then((replyTo) => this.sendFor(v.callId, text, replyTo !== null ? { replyTo } : {}))
      .catch((err) => log.warn("urgent alert not sent", { callId: v.callId, err }));
  }

  private open(callId: string, from: string, startedAt: number) {
    if (!this.showsStatus || this.views.has(callId)) return;
    const v: CallView = {
      callId,
      from,
      startedAt,
      message: Promise.resolve(null),
      steers: [],
      suggestions: [],
      lines: new Map(),
      shown: "",
      lastEditAt: this.d.clock.now(),
      editTimer: null,
      editing: Promise.resolve(),
    };
    // The first message notifies; edits after it don't. If it fails, it's tried again after
    // min_edit_interval_ms, and on every later update (see edit).
    v.message = this.sendStatus(v).then((id) => (id === null && this.schedule(v), id));
    this.views.set(callId, v);
  }

  /** Sends the status message (it has none yet); null if Telegram failed. */
  private async sendStatus(v: CallView): Promise<number | null> {
    const next = this.render(v);
    try {
      const id = await this.sendFor(v.callId, next.text, { layout: next.layout });
      v.shown = JSON.stringify(next);
      return id;
    } catch (err) {
      log.warn("status message not sent", { callId: v.callId, err });
      return null;
    }
  }

  /** Edits the status message, at most every min_edit_interval_ms. */
  private schedule(v: CallView) {
    if (v.editTimer) return;
    const wait = Math.max(0, v.lastEditAt + this.d.config().telegram.status.min_edit_interval_ms - this.d.clock.now());
    v.editTimer = setTimeout(() => {
      v.editTimer = null;
      this.queueEdit(v);
    }, wait);
  }

  private queueEdit(v: CallView) {
    v.editing = v.editing.then(() => this.edit(v));
  }

  private async edit(v: CallView) {
    const id = await v.message;
    if (id === null) {
      // The status message was never sent (Telegram failed): send it now instead of editing.
      v.lastEditAt = this.d.clock.now();
      const sent = await this.sendStatus(v);
      if (sent !== null) v.message = Promise.resolve(sent);
      return;
    }
    const next = this.render(v);
    const shown = JSON.stringify(next);
    if (shown === v.shown) return;
    v.lastEditAt = this.d.clock.now();
    try {
      await this.d.chat.edit(id, next.text, next.layout);
      v.shown = shown;
    } catch (err) {
      log.warn("status message not updated", { callId: v.callId, err });
    }
  }

  /** Sends every pending edit now (shutdown). */
  async flush() {
    for (const v of this.views.values()) {
      if (!v.editTimer) continue;
      clearTimeout(v.editTimer);
      v.editTimer = null;
      this.queueEdit(v);
    }
    await Promise.all([...this.views.values()].map((v) => v.editing));
  }

  detach() {
    this.unsubscribe();
    for (const v of this.views.values()) {
      if (v.editTimer) clearTimeout(v.editTimer);
      if (v.dropTimer) clearTimeout(v.dropTimer);
    }
  }

  /** A message from the owner's chat: steers a call, or gets a short reply saying why not. */
  async onMessage(m: OwnerMessage) {
    if (this.d.clock.now() - m.date > this.d.config().telegram.steering.stale_after_ms) return;
    const reply = (text: string) =>
      this.d.chat.send(text, { replyTo: m.messageId }).catch((err) => log.warn("reply not sent", { err }));
    const text = m.text?.trim();
    if (!text) return void (await reply("Only text messages can steer a call."));
    const hangUp = /^\/hangup(@\S+)?$/i.test(text);
    if (text.startsWith("/") && !hangUp) return void (await reply(this.help()));
    if (!this.steeringOn()) return void (await reply("Steering is turned off."));

    let callId: string | undefined;
    if (m.replyTo !== undefined) {
      callId = this.messages.get(m.replyTo);
      if (!callId) return void (await reply("I can't tell which call that was: reply to the call's status message."));
    } else {
      callId = [...this.views.values()].filter((v) => !v.ended).sort((a, b) => b.startedAt - a.startedAt)[0]?.callId;
      if (!callId) return void (await reply("No call in progress."));
    }
    const v = this.views.get(callId);
    if (!v || v.ended) return void (await reply("That call has ended."));
    if (hangUp) {
      const res = this.hangUpCall(v);
      return void (await reply(res.ok ? "Hanging up after the goodbye." : `Not hung up: ${res.reason}.`));
    }
    const steer = parseOwnerMessage(this.d.config().telegram.steering, text);
    const res = this.steerCall(v, steer.text, steer.as);
    if (!res.ok) return void (await reply(`Not sent: ${res.reason}.`));
    this.track(m.messageId, callId);
    // Says how it went out, so a prefix that made it silent (thinking) isn't a surprise.
    await this.sendFor(callId, `Sent as ${steer.as}: ${AS_EFFECT[steer.as]}.`, { replyTo: m.messageId }).catch((err) =>
      log.warn("reply not sent", { callId, err }),
    );
  }

  /**
   * A steering button under a status message: sends its text to that call, or moves it into its
   * call-flow stage. A suggestion replaced
   * since it was shown still sends what it said, as long as its generation is kept.
   */
  async onButton(b: OwnerButtonPress) {
    const answer = (notice: string) =>
      this.d.chat.answerButton(b.pressId, notice).catch((err) => log.warn("button not answered", { err }));
    const st = this.d.config().telegram.steering;
    const callId = this.messages.get(b.messageId);
    const v = callId ? this.views.get(callId) : undefined;
    let button: TelegramConfig["steering"]["buttons"][number] | { text: string; as: LiveAppend; hang_up?: boolean } | undefined;
    if (b.data.startsWith(BUTTON)) button = st.buttons[Number(b.data.slice(BUTTON.length))];
    else if (b.data.startsWith(SUGGESTION) && st.suggestions.enabled) {
      const [gen, i] = b.data.slice(SUGGESTION.length).split(":").map(Number);
      const s = v?.suggestions.find((g) => g.gen === gen)?.items[i!];
      if (s) button = { text: s.text, as: st.suggestions.as };
    }
    if (!button) return void (await answer("That button no longer does anything."));
    if (!callId || !v || v.ended) return void (await answer("That call has ended."));
    if (!this.steeringOn()) return void (await answer("Steering is turned off."));
    if ("extend_minutes" in button) {
      const res = this.d.extend(v.callId, button.extend_minutes);
      if (!res.ok) return void (await answer(`Not extended: ${res.reason}.`));
      v.limitMs = res.maxCallSeconds * 1000;
      this.schedule(v);
      return void (await answer(`Added ${button.extend_minutes} min: the call can run ${clock(v.limitMs)}.`));
    }
    if ("stage" in button) {
      const res = this.d.enterStage(v.callId, button.stage, button.label);
      const as = this.d.config().flow.rules.find((r) => r.stage === button.stage)?.then?.tell_live?.as;
      if (res.ok && as) this.noteSteer(v, as, `${button.label} (stage: ${button.stage.replaceAll("_", " ")})`);
      return void (await answer(res.ok ? `Sent: ${button.label}` : `Not sent: ${res.reason}.`));
    }
    if (button.hang_up) {
      const res = this.hangUpCall(v, button);
      return void (await answer(res.ok ? "Hanging up after the goodbye." : `Not hung up: ${res.reason}.`));
    }
    const res = this.steerCall(v, button.text, button.as);
    await answer(res.ok ? `Sent: ${button.text}` : `Not sent: ${res.reason}.`);
  }

  /**
   * Ends the call: the goodbye text (the hang_up button's, or the first one configured) goes to
   * Live, then the call hangs up once it has played.
   */
  private hangUpCall(v: CallView, button?: { text: string; as: LiveAppend }): OwnerSteerResult {
    const goodbye = button ?? this.d.config().telegram.steering.buttons.find((b) => "hang_up" in b && b.hang_up);
    if (goodbye && "text" in goodbye) {
      const said = this.steerCall(v, goodbye.text, goodbye.as);
      if (!said.ok) return said;
    }
    return this.d.hangUp(v.callId);
  }

  private steeringOn(): boolean {
    return this.d.canSteer && this.d.config().telegram.steering.enabled;
  }

  /** Sends the owner's text to the call, and shows it on the status message. */
  private steerCall(v: CallView, text: string, as: LiveAppend): OwnerSteerResult {
    const res = this.d.steer(v.callId, text, as);
    if (res.ok) this.noteSteer(v, as, text);
    return res;
  }

  /** Shows the owner's steering on the status message. */
  private noteSteer(v: CallView, as: LiveAppend, text: string) {
    v.steers.push({ at: this.d.clock.now() - v.startedAt, as, text });
    this.schedule(v);
  }

  private help(): string {
    const st = this.d.config().telegram.steering;
    const kinds = [`plain text → ${st.default}`, ...Object.entries(st.prefixes).map(([p, as]) => `${p} → ${as}`)];
    return [
      "Each call gets a status message here, updated as the call goes on.",
      "To steer the agent, reply to a call's status message, or just send a message while a call is live (it goes to the newest).",
      `How it reaches the agent: ${kinds.join(", ")}. Instructions cut the agent off; commentary and thinking don't.`,
    ].join("\n\n");
  }

  /**
   * Jev's verdict is below what the call flow needs to act on it (the first rule with
   * `verdict: { is, min }` for it), e.g. scam at 62% when waste_time needs 80%.
   */
  private leaning(c: { verdict: Verdict; confidence: number }): boolean {
    for (const r of this.d.config().flow.rules) {
      const w = r.when.verdict;
      if (w && typeof w === "object" && "is" in w && w.min !== undefined && [w.is].flat().includes(c.verdict)) return c.confidence < w.min;
    }
    return false;
  }

  /**
   * The status message: plain text, with the transcript newest first in a collapsed quote (it
   * shows its first lines until tapped), and the steering buttons while the call is live.
   */
  render(v: CallView): { text: string; layout: MessageLayout } {
    const now = v.ended ? v.startedAt + v.ended.at : this.d.clock.now();
    const head = v.ended
      ? `✅ Call ended · ${v.from || "unknown caller"} · ${clock(now - v.startedAt)} · ${v.ended.reason}`
      : `📞 Incoming call · ${v.from || "unknown caller"} · ${clock(now - v.startedAt)}${v.limitMs ? ` of ${clock(v.limitMs)}` : ""}`;
    const c = v.verdict;
    const state = [
      c ? `${this.leaning(c) ? "leaning " : ""}${c.verdict} ${Math.round(c.confidence * 100)}% · urgency ${c.urgency.toFixed(2)}` : v.ended ? "" : "listening…",
      v.stage ? `stage: ${v.stage.replaceAll("_", " ")}` : "",
    ].filter(Boolean).join(" · ");
    const before = [state ? `${head}\n${state}` : head];
    const summary = v.summary ?? v.progress?.summary;
    if (summary) before.push(`📝 ${cut(summary, 800)}`);
    if (v.progress?.questions.length) before.push(v.progress.questions.map((q) => `❓ ${cut(q, MAX_LINE_CHARS)}`).join("\n"));
    if (v.steers.length) {
      const shown = v.steers.slice(-MAX_STEERS_SHOWN);
      const more = v.steers.length - shown.length;
      before.push(
        ["🗣 Your steering" + (more ? ` (last ${shown.length} of ${v.steers.length})` : ""), ...shown.map((s) => `${clock(s.at)} ${s.as}: ${cut(s.text, 300)}`)].join("\n"),
      );
    }
    const steerable = !v.ended && this.steeringOn();
    const after: string[] = [];
    if (v.ended && v.costs) after.push(`💰 ${describeCosts(v.costs)}`);
    if (steerable) after.push("↩️ Reply to steer the agent (/help)");
    const link = this.d.callLink?.(v.callId);
    if (link) after.push(link);

    const sep = "\n\n";
    let text = before.join(sep);
    const collapsed: { offset: number; length: number }[] = [];
    if (v.lines.size) {
      // Newest first, as many as fit: the collapsed quote shows the latest lines.
      const title = `${sep}💬 Transcript, newest first\n`;
      const rest = after.length ? sep + after.join(sep) : "";
      const earlier = "… earlier lines on the call page";
      let room = MAX_CHARS - text.length - title.length - rest.length - earlier.length - 1;
      const lines: string[] = [];
      const all = [...v.lines.entries()].sort((a, b) => b[0] - a[0]);
      for (const [, l] of all) {
        const line = `${clock(l.at)} ${l.speaker}: ${cut(l.text, MAX_LINE_CHARS)}`;
        if (line.length + 1 > room) break;
        lines.push(line);
        room -= line.length + 1;
      }
      if (lines.length < all.length) lines.push(earlier);
      const quote = lines.join("\n");
      text += title;
      collapsed.push({ offset: text.length, length: quote.length });
      text += quote + rest;
    } else if (after.length) {
      text += sep + after.join(sep);
    }
    const buttons: { label: string; data: string }[][] = [];
    if (steerable) {
      const st = this.d.config().telegram.steering;
      if (st.buttons.length) buttons.push(st.buttons.map((b, i) => ({ label: b.label, data: `${BUTTON}${i}` })));
      const sug = st.suggestions.enabled ? v.suggestions.at(-1) : undefined;
      if (sug) buttons.push(...sug.items.map((s, i) => [{ label: cut(s.label, MAX_LABEL_CHARS), data: `${SUGGESTION}${sug.gen}:${i}` }]));
    }
    text = text.slice(0, MAX_CHARS);
    const inText = collapsed.filter((q) => q.length > 0 && q.offset + q.length <= text.length);
    return {
      text,
      layout: { ...(inText.length ? { collapsed: inText } : {}), ...(buttons.length ? { buttons } : {}) },
    };
  }
}

/**
 * A typed message as steering (telegram.yaml steering): a leading prefix picks how it reaches Live
 * and is removed, otherwise steering.default.
 */
export function parseOwnerMessage(st: TelegramConfig["steering"], message: string): { as: LiveAppend; text: string } {
  const text = message.trim();
  // Longest first, so "!!" can mean something other than "!".
  const prefix = Object.keys(st.prefixes).sort((a, b) => b.length - a.length).find((p) => text.startsWith(p));
  return prefix ? { as: st.prefixes[prefix]!, text: text.slice(prefix.length).trim() } : { as: st.default, text };
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** m:ss */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
