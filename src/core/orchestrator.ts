import { fillCurrentTime, LUNA_RESPONSE, type AppConfig, type TellLive } from "./config";
import { decide, matchRule, type FlowAction } from "./flow";
import type { Agent, Classifier, Clock, DelegationRequest, EventBus, Notifier, ToolContext } from "./ports";
import { TranscriptBuffer } from "./transcript";
import type { AppendSource, CallEvent, CallMeta, Classification, FlowDecision, LunaTrigger, Speaker, ToolCallRecord } from "./types";

// Transcript buffer → Jev (on caller pauses) → call flow → tell Live, ask Luna, or hang up.
// Knows nothing about audio; CallSession wires it to the voice session and the phone call.

/** A text for Live, with what the delivery queue needs to know about it. */
export interface Steer {
  message: TellLive;
  /**
   * The decision revision guidance was made under: dropped if a newer decision lands before it
   * is sent. Stage texts have none (a newer stage replaces them by key; dropping one would leave
   * the call in a stage Live was never told about).
   */
  rev?: number;
  /** a message still waiting with the same key is dropped (e.g. an older stage) */
  key?: string;
  /** what the text answers (default: stage) */
  source?: AppendSource;
  /** the rule's stage, for stage texts and Luna's replies to a rule */
  stage?: string;
  /** answers this Live delegation; a delegation is always answered, with `fallback` if superseded */
  delegation?: { id: string; fallback: TellLive };
}

/** Where Luna's reply goes. */
export interface LunaTarget {
  /** the ask_luna rule: its tell_live (if any) sends the reply, and the call enters its stage */
  rule?: { stage: string; message?: TellLive };
  /** the Live delegation the reply answers (call-flow.yaml when_live_asks_for_help) */
  delegationId?: string;
}

/** How the orchestrator acts on the live call. */
export interface Steering {
  tellLive(s: Steer): void;
  hangup(reason: string): Promise<void>;
}

export interface OrchestratorDeps {
  meta: CallMeta;
  config: () => AppConfig;
  classifier: Classifier;
  agent: Agent;
  bus: EventBus;
  notifier: Notifier;
  steer: Steering;
  clock: Clock;
  ownerNumber: string;
  /** replay/dry-run: tools are recorded but have no side effects */
  dryRun?: boolean;
}

const MAX_SMS_PER_CALL = 2;
/** instructions.append is limited to ~500 tokens; stay well under */
const MAX_APPEND_CHARS = 1800;

export class Orchestrator {
  readonly transcript: TranscriptBuffer;
  /** the call-flow stage (see FlowState.stage) */
  stage: string | null = null;
  lastClassification: Classification | null = null;
  lunaCalls = 0;
  jevTicks = 0;
  jevInputTokens = 0;
  readonly messages: { name?: string; callback?: string; message: string }[] = [];
  readonly actions: FlowAction[] = [];

  /**
   * Decision revision: bumps whenever the call flow's decision changes (another rule matched, or
   * a hangup). Guidance made under an older revision is stale and never sent.
   */
  revision = 0;
  /** the rule Jev's answers last matched */
  private decision: string | null = null;

  private lastLunaAt: number | null = null;
  private lastLunaCallerRev: number | null = null;
  /** the Luna call in flight (only ever one); never rejects */
  private lunaInFlight: Promise<string> | null = null;
  /** a Luna call the flow wanted during cooldown or while Luna was busy; poll() runs it when due */
  private deferredLuna: { reason: string; rule: NonNullable<LunaTarget["rule"]>; atMs: number; callerRev: number } | null = null;
  private smsSent = 0;
  /** a Jev call is running (only ever one) */
  private classifying = false;
  /** last caller transcript fragment (wall clock) */
  private callerHeardAt = 0;
  /** first caller fragment not yet seen by Jev, or null when Jev is up to date */
  private pendingSince: number | null = null;
  /** consecutive Jev failures, and when poll() may retry (wall clock) */
  private jevFailures = 0;
  private jevRetryAt = 0;
  /** Luna's conversation so far (AgentResult.responseId); the next run continues it */
  private lunaChain: string | undefined;
  private ended = false;
  private jevAborts = new Set<AbortController>();
  private lunaAborts = new Set<AbortController>();

  constructor(private d: OrchestratorDeps) {
    this.transcript = new TranscriptBuffer(() => this.elapsed());
  }

  elapsed() {
    return this.d.clock.now() - this.d.meta.startedAt;
  }

  private emit(ev: CallEvent) {
    this.d.bus.publish(ev);
  }

  private note(level: "info" | "warn" | "error", message: string) {
    this.emit({ type: "note", callId: this.d.meta.callId, at: this.elapsed(), level, message });
  }

  onTranscriptDelta(speaker: Speaker, itemId: string, delta: string) {
    if (!delta) return;
    if (speaker === "caller") {
      this.callerHeardAt = this.d.clock.now();
      this.pendingSince ??= this.callerHeardAt;
    }
    const entry = this.transcript.delta(speaker, itemId, delta);
    this.emit({ type: "transcript", callId: this.d.meta.callId, entry });
  }

  onTranscriptDone(speaker: Speaker, itemId: string, text?: string) {
    const entry = this.transcript.done(speaker, itemId, text);
    if (entry.text) this.emit({ type: "transcript", callId: this.d.meta.callId, entry });
  }

  /** The agent's reply delay (see TranscriptBuffer.replied), shown with its utterance. */
  onAgentReply(ms: number) {
    const entry = this.transcript.replied(ms);
    if (entry?.text) this.emit({ type: "transcript", callId: this.d.meta.callId, entry });
  }

  /**
   * Turn-based classification trigger; cheap, called every ~100 ms by the call session.
   * Jev runs when the caller pauses (no new caller words for classify.settle_ms), or at least
   * every classify.max_wait_ms while they keep talking. Words that arrive during a Jev call
   * trigger the next one as soon as it returns. Live's transcripts ignore background noise.
   * A failed Jev call leaves the words pending and is retried with backoff.
   */
  poll() {
    if (this.ended) return;
    this.runDeferredLuna();
    if (this.classifying || this.pendingSince === null) return;
    const c = this.d.config().flow.timing.classify;
    const now = this.d.clock.now();
    if (now < this.jevRetryAt) return;
    if (now - this.callerHeardAt >= c.settle_ms || now - this.pendingSince >= c.max_wait_ms) void this.classify();
  }

  /** Runs a deferred Luna call once its cooldown is over, unless a later Luna call already saw that speech. */
  private runDeferredLuna() {
    const d = this.deferredLuna;
    if (!d || this.classifying || this.lunaInFlight || this.elapsed() < d.atMs) return;
    this.deferredLuna = null;
    if (this.lastLunaCallerRev !== null && this.lastLunaCallerRev >= d.callerRev) {
      this.note("info", `queued Luna call (${d.reason}) skipped: a later Luna call already saw that speech`);
      return;
    }
    void this.runLuna(d.reason, { rule: d.rule });
  }

  /** Caller words Jev hasn't seen yet. */
  get pending(): boolean {
    return this.pendingSince !== null;
  }

  /** One Jev classification of the transcript so far, then the call flow. Public for replay. */
  async classify(): Promise<FlowAction | null> {
    if (this.ended || this.classifying) return null;
    const cfg = this.d.config();
    this.classifying = true;
    const since = this.pendingSince;
    this.pendingSince = null;
    const ac = new AbortController();
    this.jevAborts.add(ac);
    let c: Classification;
    try {
      c = await this.d.classifier.classify({
        meta: this.d.meta,
        transcript: this.transcript.all(),
        config: { ...cfg.jev, context: fillCurrentTime(cfg.jev.context, this.d.clock.now()) },
        signal: ac.signal,
      });
    } catch (err) {
      if (this.ended) return null;
      // Put the words back so poll() retries them, backing off while Jev keeps failing.
      if (since !== null) this.pendingSince = Math.min(since, this.pendingSince ?? since);
      const r = cfg.flow.timing.classify;
      const backoff = Math.min(r.retry_max_ms, r.retry_min_ms * 2 ** this.jevFailures++);
      this.jevRetryAt = this.d.clock.now() + backoff;
      this.note("warn", `Jev classification failed (retrying in ${backoff} ms): ${errMsg(err)}`);
      return null;
    } finally {
      this.classifying = false;
      this.jevAborts.delete(ac);
    }
    if (this.ended) return null;
    this.jevFailures = 0;
    this.jevRetryAt = 0;
    this.jevTicks++;
    this.jevInputTokens += inputTokens(c.raw);
    this.lastClassification = c;

    // The decision is the matched rule, even one with nothing new to tell Live: scam → genuine
    // (Luna starts) → scam ends "waste_time: unchanged", which still overrides the genuine plan.
    const rule = matchRule(c, this.stage, cfg.flow.rules)?.stage ?? null;
    const action = decide(
      c,
      {
        elapsedMs: this.elapsed(),
        stage: this.stage,
        lunaCalls: this.lunaCalls,
        lastLunaAt: this.lastLunaAt,
        lastLunaCallerRev: this.lastLunaCallerRev,
        callerRev: this.transcript.callerRev,
      },
      cfg,
    );
    if ((rule !== null && rule !== this.decision) || action.kind === "end_call") {
      this.decision = rule ?? this.decision;
      // Overrides a Luna call still waiting for its cooldown, and guidance from one still running.
      if (this.deferredLuna) this.note("info", `queued Luna call (${this.deferredLuna.reason}) cancelled: the call flow moved on`);
      this.deferredLuna = null;
      this.revision++;
    }
    const { raw: _raw, ...shown } = c;
    this.emit({ type: "classification", callId: this.d.meta.callId, at: this.elapsed(), classification: shown, decision: this.describe(rule, action) });
    await this.apply(action);
    return action;
  }

  /** What the call flow does with a Jev result, as the timeline shows it. */
  private describe(rule: string | null, action: FlowAction): FlowDecision {
    const cooldownEnd = (this.lastLunaAt ?? 0) + this.d.config().luna.limits.cooldown_ms;
    if (action.kind === "luna" && this.lunaInFlight) return { rule, action: "luna_deferred", reason: `${action.reason}; Luna busy`, atMs: cooldownEnd };
    if (action.kind === "luna_deferred") return { rule, action: action.kind, reason: action.reason, atMs: action.atMs };
    if (action.kind === "none" && action.lunaSkipped) return { rule, action: "luna_skipped", reason: action.reason };
    return { rule, action: action.kind, reason: action.kind === "tell_live" ? action.stage.replaceAll("_", " ") : action.reason };
  }

  private async apply(action: FlowAction) {
    if (action.kind !== "none") this.actions.push(action);
    switch (action.kind) {
      case "none":
        return;
      case "tell_live":
        this.stage = action.stage;
        this.d.steer.tellLive({ message: action.message, key: "stage", source: "stage", stage: action.stage });
        this.emit({ type: "stage", callId: this.d.meta.callId, at: this.elapsed(), stage: action.stage, as: action.message.as });
        return;
      case "luna": {
        // Don't block classification on Luna. One Luna call at a time: if one is running (it
        // started before these words), run another once it's done and the cooldown allows.
        const rule = { stage: action.stage, message: action.message };
        if (this.lunaInFlight) this.defer(action.reason, rule, (this.lastLunaAt ?? 0) + this.d.config().luna.limits.cooldown_ms);
        else void this.runLuna(action.reason, { rule });
        return;
      }
      case "luna_deferred":
        this.defer(action.reason, { stage: action.stage, message: action.message }, action.atMs);
        return;
      case "end_call":
        await this.d.steer.hangup(action.reason);
        return;
    }
  }

  private defer(reason: string, rule: NonNullable<LunaTarget["rule"]>, atMs: number) {
    this.deferredLuna = { reason, rule, atMs, callerRev: this.transcript.callerRev };
  }

  /**
   * Calls Luna with the transcript and tools, and sends her reply to `target`.
   * Calls are serialized: this waits for any Luna call in flight, then runs with the latest transcript.
   * Returns Luna's reply as sent to Live ("" if none was sent).
   */
  async runLuna(reason: string, target: LunaTarget = {}): Promise<string> {
    while (this.lunaInFlight) await this.lunaInFlight;
    if (this.ended) return "";
    const run = this.callLuna(reason, this.lastClassification, target);
    this.lunaInFlight = run;
    try {
      return await run;
    } finally {
      if (this.lunaInFlight === run) this.lunaInFlight = null;
    }
  }

  private async callLuna(reason: string, c: Classification | null, target: LunaTarget, afterCall = false): Promise<string> {
    const cfg = this.d.config();
    const help = cfg.flow.when_live_asks_for_help;
    const template = afterCall ? undefined : target.delegationId ? help.tell_live : target.rule?.message;
    const trigger: LunaTrigger = afterCall ? "after_call" : target.delegationId ? "delegation" : "rule";
    if (!afterCall && this.lunaCalls >= cfg.luna.limits.max_calls) {
      this.note("info", `Luna not called (${reason}): limit of ${cfg.luna.limits.max_calls} calls reached`);
      return "";
    }
    this.lunaCalls++;
    this.emit({
      type: "luna.started",
      callId: this.d.meta.callId,
      at: this.elapsed(),
      reason,
      trigger,
      ...(target.delegationId ? { delegationId: target.delegationId } : {}),
    });
    this.lastLunaAt = this.elapsed();
    this.lastLunaCallerRev = this.transcript.callerRev;
    const rev = this.revision;
    const ac = new AbortController();
    this.lunaAborts.add(ac);
    try {
      const res = await this.d.agent.run({
        meta: this.d.meta,
        transcript: this.transcript.all(),
        classification: c,
        reason,
        // No owner number means SMS is disabled; don't offer Luna a tool that can only fail.
        enabledTools: (afterCall ? cfg.luna.after_call.tools : cfg.luna.tools).filter((t) => this.d.ownerNumber || t !== "send_sms_to_owner"),
        tools: this.toolContext(),
        signal: ac.signal,
        previousResponseId: this.lunaChain,
      });
      // A failed run leaves the chain where it was; the next run resends the full transcript anyway.
      if (res.responseId) this.lunaChain = res.responseId;
      const instructions = res.instructions?.trim().slice(0, MAX_APPEND_CHARS) || undefined;
      // Luna started before the call flow moved on (e.g. genuine → waste_time): its guidance
      // would pull Live back to the old plan.
      const stale = this.revision !== rev;
      // After hangup there's no voice session to guide, but the tool calls above still happened.
      const dropped = !instructions
        ? undefined
        : !template
          ? "nothing is sent to Live for this"
          : this.ended
            ? "the call had ended"
            : stale
              ? `the call moved to ${this.stage ?? "a new stage"} while Luna ran`
              : undefined;
      const guidance = instructions && !dropped ? instructions : "";
      if (guidance) {
        const message = { ...template!, text: template!.text.replace(LUNA_RESPONSE, () => guidance) };
        if (target.delegationId) {
          this.d.steer.tellLive({ message, rev, source: "delegation", delegation: { id: target.delegationId, fallback: help.fallback } });
        } else {
          const stage = target.rule!.stage;
          const changed = this.stage !== stage;
          this.stage = stage;
          this.d.steer.tellLive({ message, rev, source: "luna", stage });
          if (changed) this.emit({ type: "stage", callId: this.d.meta.callId, at: this.elapsed(), stage, as: message.as });
        }
      }
      this.emit({
        type: "luna",
        callId: this.d.meta.callId,
        at: this.elapsed(),
        reason,
        trigger,
        instructions,
        ...(dropped ? { dropped } : {}),
        toolCalls: res.toolCalls,
      });
      return guidance;
    } catch (err) {
      if (!ac.signal.aborted) this.note("error", `Luna failed: ${errMsg(err)}`);
      // Ends the Luna call on the timeline.
      this.emit({
        type: "luna",
        callId: this.d.meta.callId,
        at: this.elapsed(),
        reason,
        trigger,
        dropped: ac.signal.aborted ? "cancelled" : "Luna failed",
        toolCalls: [],
      });
      return "";
    } finally {
      this.lunaAborts.delete(ac);
    }
  }

  /**
   * The voice model delegated a request to the client; Luna's reply answers it, or the
   * fallback if Luna had none (or it went stale). Returns Luna's reply or the fallback text.
   */
  async delegate(req: DelegationRequest): Promise<string> {
    const out = await this.runLuna(`voice agent asked for help (delegation ${req.id})`, { delegationId: req.id });
    if (out || this.ended) return out;
    const { fallback } = this.d.config().flow.when_live_asks_for_help;
    this.d.steer.tellLive({ message: fallback, source: "delegation", delegation: { id: req.id, fallback } });
    return fallback.text;
  }

  /**
   * After hangup: one Luna run that saves the caller's message and texts the owner if needed
   * (luna.yaml after_call). Nothing goes to Live. Waits up to timeoutMs, then cancels it.
   */
  async afterCall(timeoutMs: number) {
    const a = this.d.config().luna.after_call;
    if (!a.enabled || !this.transcript.all().some((e) => e.speaker === "caller")) return;
    if (this.lastClassification && a.skip_verdicts.includes(this.lastClassification.verdict)) return;
    await this.idle();
    const run = this.callLuna(a.task, this.lastClassification, {}, true);
    this.lunaInFlight = run;
    // callLuna never rejects; drain() waits for this to clear.
    void run.finally(() => {
      if (this.lunaInFlight === run) this.lunaInFlight = null;
    });
    await this.drain(timeoutMs);
  }

  private toolContext(): ToolContext {
    const record = (call: ToolCallRecord) =>
      this.emit({ type: "tool", callId: this.d.meta.callId, at: this.elapsed(), call });
    return {
      sendSmsToOwner: async (text) => {
        let result: string;
        if (this.smsSent >= MAX_SMS_PER_CALL) result = "refused: SMS limit for this call reached";
        else if (!this.d.ownerNumber) result = "refused: SMS to owner is not configured";
        else if (this.d.dryRun) result = "dry run: not sent";
        else {
          try {
            await this.d.notifier.sms(this.d.ownerNumber, text.slice(0, 600));
            this.smsSent++;
            result = "sent";
          } catch (err) {
            result = `failed: ${errMsg(err)}`;
          }
        }
        record({ name: "send_sms_to_owner", args: { text }, result });
        return result;
      },
      endCall: async (reason) => {
        const result = this.d.dryRun ? "dry run: not ended" : this.ended ? "call already ended" : "ending call";
        record({ name: "end_call", args: { reason }, result });
        // Not awaited: hanging up drains Luna, i.e. waits for this very run to finish.
        if (result === "ending call") void this.d.steer.hangup(`Luna: ${reason}`);
        return result;
      },
      takeMessage: async (msg) => {
        this.messages.push(msg);
        record({ name: "take_message", args: { ...msg }, result: "recorded" });
        return "recorded";
      },
    };
  }

  /** Resolves when no Luna call is in flight (used by the replay harness). */
  async idle() {
    while (this.lunaInFlight) await this.lunaInFlight;
  }

  /** Where the end-of-call summary continues Luna's conversation, if Luna ran. */
  get lunaResponseId(): string | undefined {
    return this.lunaChain;
  }

  /**
   * Stops classifying: cancels the Jev call in flight and any Luna call not yet started. A Luna
   * call already running is left to finish (see drain), as it may still text the owner or take
   * a message.
   */
  end() {
    this.ended = true;
    this.deferredLuna = null;
    for (const ac of this.jevAborts) ac.abort();
    this.jevAborts.clear();
  }

  /** After end(): waits up to timeoutMs for a running Luna call, then cancels it. */
  async drain(timeoutMs: number) {
    if (!this.lunaInFlight) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.idle().then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs))),
    ]);
    clearTimeout(timer);
    if (!timedOut) return;
    this.note("warn", `Luna still running ${timeoutMs} ms after hangup; cancelled`);
    for (const ac of this.lunaAborts) ac.abort();
    this.lunaAborts.clear();
  }
}

function inputTokens(raw: unknown): number {
  const n = (raw as { usage?: { input_tokens?: unknown } } | undefined)?.usage?.input_tokens;
  return typeof n === "number" ? n : 0;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
