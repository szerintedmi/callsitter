import { fillCurrentTime, LUNA_RESPONSE, MAX_APPEND_CHARS, TIME_UP, type AppConfig, type TellLive } from "./config";
import { CostMeter } from "./cost";
import { decide, matchRule, type FlowAction } from "./flow";
import type { Agent, Classifier, Clock, DelegationRequest, EventBus, ToolContext } from "./ports";
import { TranscriptBuffer } from "./transcript";
import type { AppendSource, CallEvent, CallMeta, Classification, FlowDecision, LunaTrigger, Speaker, Suggestion, ToolCallRecord } from "./types";

// Transcript buffer → Jev (on caller pauses) → call flow → tell Live, ask Luna, or hang up.
// Knows nothing about audio; CallSession wires it to the voice session and the phone call.

/** A text for Live, with what the delivery queue needs to know about it. */
export interface Steer {
  message: TellLive;
  /**
   * The decision revision guidance was made under: dropped if a newer decision lands before it
   * is sent. Stage texts have none (a newer stage replaces them by key; dropping one would leave
   * the call in a stage Live was never told about). A delegation's is a flowRevision: only the
   * call flow makes it stale, not the owner steering. Live asked for help and is waiting, so the
   * owner's message doesn't turn Luna's answer into the fallback.
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
  /** whether the owner sees status messages; unset or false, no rolling summaries (luna.yaml progress) */
  ownerStatus?: () => boolean;
  steer: Steering;
  clock: Clock;
  /** replay/dry-run: tools are recorded but have no side effects */
  dryRun?: boolean;
}

/** Luna's steering buttons for the owner beyond this many are dropped (luna.yaml progress asks for fewer) */
const MAX_SUGGESTIONS = 4;

export class Orchestrator {
  readonly transcript: TranscriptBuffer;
  /** the call-flow stage (see FlowState.stage) */
  stage: string | null = null;
  lastClassification: Classification | null = null;
  lunaCalls = 0;
  jevTicks = 0;
  /** what the call's Luna and Jev calls cost so far */
  readonly costs: CostMeter;
  readonly actions: FlowAction[] = [];

  /**
   * Decision revision: bumps whenever the call flow's decision changes (another rule matched, or
   * a hangup). Guidance made under an older revision is stale and never sent.
   */
  revision = 0;
  /** like revision, but not bumped by the owner steering (see Steer.rev) */
  flowRevision = 0;
  /** why the revision last bumped, for guidance dropped as stale */
  private revisionCause = "";
  /** the rule Jev's answers last matched */
  private decision: string | null = null;
  /** what the owner told the agent from Telegram, oldest first; Luna sees it */
  readonly ownerMessages: string[] = [];
  /** the rolling summary in flight; cancelled at hangup, when Luna's final summary takes over */
  private progressAbort: AbortController | null = null;
  private lastProgressAt: number | null = null;
  private lastProgressCallerRev = 0;
  /** Jev says the owner's summary is out of date (luna.yaml progress.when), and how sure it is */
  private progressDue: string | null = null;
  /** the latest rolling summary, and the caller's words it saw (TranscriptBuffer.callerRev) */
  lastProgress: { summary: string; callerRev: number } | null = null;
  /** the owner's steering buttons from the latest rolling summary; the next one sees them */
  private suggestions: Suggestion[] = [];
  /** the last transcript entry (seq) the owner's latest summary saw; Jev gets a marker after it */
  private ownerUpdatedThrough: number | undefined;

  private lastLunaAt: number | null = null;
  private lastLunaCallerRev: number | null = null;
  /** the Luna call in flight (only ever one); never rejects */
  private lunaInFlight: Promise<string> | null = null;
  /** a Luna call the flow wanted during cooldown or while Luna was busy; poll() runs it when due */
  private deferredLuna: { reason: string; rule: NonNullable<LunaTarget["rule"]>; atMs: number; callerRev: number } | null = null;
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
    this.costs = new CostMeter(() => this.d.config().cost);
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
    this.runProgress();
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
        ...(this.ownerUpdatedThrough !== undefined ? { ownerUpdatedThrough: this.ownerUpdatedThrough } : {}),
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
    this.costs.jevInputTokens += inputTokens(c.raw);
    this.lastClassification = c;
    const w = cfg.luna.progress.when;
    const pUpdate = c.answers[w.question]?.probabilities[w.answer];
    if (pUpdate !== undefined && pUpdate >= w.min) this.progressDue = `Jev: ${w.question} ${w.answer} ${pUpdate.toFixed(2)} ≥ ${w.min}`;

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
      this.bump(`the call flow moved to ${this.decision ?? "another rule"}`);
    }
    const { raw: _raw, ...shown } = c;
    this.emit({
      type: "classification",
      callId: this.d.meta.callId,
      at: this.elapsed(),
      classification: shown,
      decision: this.describe(rule, action),
      ...(pUpdate !== undefined ? { ownerUpdate: { question: w.question, answer: w.answer, probability: pUpdate, min: w.min } } : {}),
    });
    await this.apply(action);
    return action;
  }

  /**
   * timing.time_up: the call is nearly over. Live is told to say goodbye, and the call enters the
   * time_up stage (rules in that stage keep it there); pending Luna guidance is dropped.
   */
  timeUp() {
    const tu = this.d.config().flow.timing.time_up;
    if (this.ended || !tu) return;
    this.decision = TIME_UP;
    if (this.deferredLuna) this.note("info", `queued Luna call (${this.deferredLuna.reason}) cancelled: time is up`);
    this.deferredLuna = null;
    this.bump("time was up");
    void this.apply({ kind: "tell_live", stage: TIME_UP, message: tu.tell_live });
  }

  /**
   * The owner's stage button (telegram.yaml steering.buttons): the call enters that call-flow
   * stage as if its rule had matched, and Live gets the rule's tell_live. Luna sees the button
   * from her next run on; pending Luna guidance is dropped. False if there's no such stage.
   */
  enterStage(stage: string, label: string): boolean {
    const message = this.d.config().flow.rules.find((r) => r.stage === stage)?.then?.tell_live;
    if (this.ended || !message) return false;
    this.ownerMessages.push(`(button) ${label}`);
    this.decision = stage;
    if (this.deferredLuna) this.note("info", `queued Luna call (${this.deferredLuna.reason}) cancelled: the owner moved the call on`);
    this.deferredLuna = null;
    this.bump(`the owner moved the call to ${stage}`);
    void this.apply({ kind: "tell_live", stage, message });
    return true;
  }

  private bump(cause: string, byOwner = false) {
    this.revision++;
    if (!byOwner) this.flowRevision++;
    this.revisionCause = cause;
  }

  /**
   * The owner steered the call from Telegram (the call session sends the text to Live). Luna sees
   * it from her next run on, and guidance from a run that started before it is dropped, except an
   * answer to Live's request for help.
   */
  ownerSteered(text: string) {
    if (this.ended) return;
    this.ownerMessages.push(text);
    this.bump("the owner steered the call", true);
  }

  /**
   * Luna's rolling summary for the owner's status message (luna.yaml progress), one at a time:
   * when Jev says there's news for the owner (progress.when), at most every min_interval_ms, or
   * after max_interval_ms if the caller has said anything since. Needs status messages
   * (ownerStatus) and an agent that writes them. What it covered is only recorded once it succeeds: a failed one is
   * retried after min_interval_ms.
   */
  private runProgress() {
    const cfg = this.d.config();
    const p = cfg.luna.progress;
    if (!this.d.agent.progress || !p.enabled || !this.d.ownerStatus?.() || this.progressAbort) return;
    const rev = this.transcript.callerRev;
    if (rev === this.lastProgressCallerRev || this.pendingSince !== null || this.classifying) return;
    // Before the first summary, the interval runs from the start of the call.
    const since = this.elapsed() - (this.lastProgressAt ?? 0);
    if (this.lastProgressAt !== null && since < p.min_interval_ms) return;
    const stale = p.max_interval_ms !== null && since >= p.max_interval_ms;
    if (!this.progressDue && !stale) return;
    const reason = this.progressDue ?? `${Math.round(since / 1000)} s since the ${this.lastProgressAt === null ? "call started" : "last update"}, with new caller words`;
    const ac = new AbortController();
    this.progressAbort = ac;
    this.progressDue = null;
    const started = this.d.clock.now();
    this.lastProgressAt = this.elapsed();
    const transcript = this.transcript.all();
    // Jev's marker goes after the utterances that were complete: words still coming into an open
    // one stay after it, so Jev sees them as new.
    const open = transcript.findIndex((e) => !e.final);
    const through = (open < 0 ? transcript.at(-1) : transcript[open - 1])?.seq;
    void this.d.agent.progress(this.d.meta, transcript, { ownerMessages: [...this.ownerMessages], suggestions: this.suggestions, signal: ac.signal })
      .then((r) => {
        const usage = r.usage ? this.costs.addLuna(r.usage) : undefined;
        if (this.ended) return;
        this.lastProgressCallerRev = rev;
        if (through !== undefined) this.ownerUpdatedThrough = through;
        const questions = r.questions.map((q) => q.trim()).filter(Boolean);
        const summary = r.summary.trim();
        if (summary) this.lastProgress = { summary, callerRev: rev };
        this.suggestions = r.suggestions
          .map((s) => ({ label: s.label.trim(), text: s.text.trim() }))
          .filter((s) => s.label && s.text)
          .slice(0, MAX_SUGGESTIONS);
        this.emit({
          type: "progress",
          callId: this.d.meta.callId,
          at: this.elapsed(),
          summary,
          questions,
          suggestions: this.suggestions,
          alert: r.alert,
          reason,
          tookMs: this.d.clock.now() - started,
          ...(usage ? { usage } : {}),
        });
      })
      .catch((err) => {
        if (ac.signal.aborted || this.ended) return;
        this.note("warn", `progress summary failed (retrying in ${Math.round(p.min_interval_ms / 1000)} s): ${errMsg(err)}`);
        // Still due: poll() retries once min_interval_ms has passed.
        this.progressDue ??= reason;
      })
      .finally(() => {
        if (this.progressAbort === ac) this.progressAbort = null;
      });
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

  private async callLuna(reason: string, c: Classification | null, target: LunaTarget): Promise<string> {
    const cfg = this.d.config();
    const help = cfg.flow.when_live_asks_for_help;
    const template = target.delegationId ? help.tell_live : target.rule?.message;
    const trigger: LunaTrigger = target.delegationId ? "delegation" : "rule";
    if (this.lunaCalls >= cfg.luna.limits.max_calls) {
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
    const flowRev = this.flowRevision;
    const ac = new AbortController();
    this.lunaAborts.add(ac);
    try {
      const res = await this.d.agent.run({
        meta: this.d.meta,
        transcript: this.transcript.all(),
        classification: c,
        reason,
        enabledTools: cfg.luna.tools,
        tools: this.toolContext(),
        signal: ac.signal,
        previousResponseId: this.lunaChain,
        ownerMessages: [...this.ownerMessages],
      });
      // A failed run leaves the chain where it was; the next run resends the full transcript anyway.
      if (res.responseId) this.lunaChain = res.responseId;
      const usage = res.usage ? this.costs.addLuna(res.usage) : undefined;
      const instructions = res.instructions?.trim().slice(0, MAX_APPEND_CHARS) || undefined;
      // Luna started before the call flow moved on (e.g. genuine → waste_time): its guidance
      // would pull Live back to the old plan.
      // An answer to Live's request for help is only stale if the call flow moved on (Steer.rev).
      const stale = target.delegationId ? this.flowRevision !== flowRev : this.revision !== rev;
      // After hangup there's no voice session to guide, but the tool calls above still happened.
      const dropped = !instructions
        ? undefined
        : !template
          ? "nothing is sent to Live for this"
          : this.ended
            ? "the call had ended"
            : stale
              ? `${this.revisionCause} while Luna ran`
              : undefined;
      const guidance = instructions && !dropped ? instructions : "";
      if (guidance) {
        const message = { ...template!, text: template!.text.replace(LUNA_RESPONSE, () => guidance) };
        if (target.delegationId) {
          this.d.steer.tellLive({ message, rev: flowRev, source: "delegation", delegation: { id: target.delegationId, fallback: help.fallback } });
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
        ...(usage ? { usage } : {}),
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

  private toolContext(): ToolContext {
    const record = (call: ToolCallRecord) =>
      this.emit({ type: "tool", callId: this.d.meta.callId, at: this.elapsed(), call });
    return {
      endCall: async (reason) => {
        const result = this.d.dryRun ? "dry run: not ended" : this.ended ? "call already ended" : "ending call";
        record({ name: "end_call", args: { reason }, result });
        // Not awaited: hanging up drains Luna, i.e. waits for this very run to finish.
        if (result === "ending call") void this.d.steer.hangup(`Luna: ${reason}`);
        return result;
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
   * call already running is left to finish (see drain), so the summary sees what it did.
   */
  end() {
    this.ended = true;
    this.deferredLuna = null;
    for (const ac of this.jevAborts) ac.abort();
    this.jevAborts.clear();
    this.progressAbort?.abort();
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
