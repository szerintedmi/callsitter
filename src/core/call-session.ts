import { b64decode, b64encode, BYTES_PER_MS, isCodec, levelDbfs, SILENCE_BYTE, type AudioFormat, type Codec } from "./audio";
import { fillCurrentTime, type AppConfig } from "./config";
import { errMsg, Orchestrator, type Steer } from "./orchestrator";
import type {
  Agent,
  Classifier,
  Clock,
  EventBus,
  MediaChannel,
  Notifier,
  Telephony,
  VoiceAgent,
  VoiceSession,
  VoiceSessionHandlers,
} from "./ports";
import type { CallMeta } from "./types";

// One phone call: media leg ↔ voice session, with the orchestrator steering.
// Maps 1:1 to a Durable Object in the Cloudflare port.

export interface CallSessionDeps {
  meta: CallMeta;
  callControlId: string;
  config: () => AppConfig;
  voice: VoiceAgent;
  classifier: Classifier;
  agent: Agent;
  bus: EventBus;
  /** messages to the owner; unset turns them off */
  notifier?: Notifier;
  /** the call's page on the admin UI, linked from the summary sent to the owner */
  callLink?: (callId: string) => string;
  telephony: Telephony;
  clock: Clock;
  media: MediaChannel;
  /**
   * The voice vendor terminates the phone leg itself (OpenAI SIP): caller audio never reaches
   * us, so there is no input to keep running, and `media` only sees agent audio copies.
   */
  mediaViaVoice?: boolean;
  /** Luna's tools are recorded but have no side effects (browser test calls) */
  dryRun?: boolean;
  /** recorded greetings in the agent's voice (see greeting.ts); without one, Live is asked to greet */
  greetings?: { get(codec: Codec): Uint8Array | null };
  onStopped?: (callId: string) => void;
}

/** caller audio kept while Live connects (~10 s of 20 ms frames) */
const EARLY_AUDIO_MAX_FRAMES = 500;

/**
 * idle → connecting (Live connecting, greeting playing) → active → stopping (hung up: Luna
 * draining, summary) → finalized. The call deadline runs from connecting on.
 */
export type CallPhase = "idle" | "connecting" | "active" | "stopping" | "finalized";

export class CallSession {
  readonly orch: Orchestrator;
  private voice: VoiceSession | null = null;
  private codec: AudioFormat = "pcmu";
  /** drives the classification trigger and the silence watchdog */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private timeUpTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Last caller speech or agent speech (wall clock). Agent speech counts until it has played
   * out, so this can be in the future.
   */
  private lastActivityAt = 0;
  /** when the agent audio sent so far finishes playing at the caller's end (wall clock) */
  private agentPlayoutUntil = 0;
  /** when the agent's last speech (not padding) finishes playing (wall clock) */
  private agentSpeechUntil = 0;
  /** send: when_agent_idle messages held back so they don't cut the agent off (see flushHeldInstructions) */
  private held: { steer: Steer; since: number }[] = [];
  /** a hangup the call flow or Luna asked for, waiting for the agent's goodbye to play out */
  private pendingHangup: { reason: string; since: number; done: Promise<void>; resolve: () => void } | null = null;
  /** last caller audio loud enough to be speech (wall clock) */
  private callerSpeechAt = 0;
  /** last non-silent agent audio received (wall clock) */
  private agentSpeechAt = 0;
  private silencePrompts = 0;
  /** Live's last reported context usage (0..1), to spot compaction */
  private contextRatio: number | undefined;
  /** last caller audio frame from the media leg, or the last silence we filled in (wall clock) */
  private callerAudioAt = 0;
  /** when the media leg stopped sending audio, or null while it flows */
  private stalledSince: number | null = null;
  private stallWarned = false;
  /** last caller transcript delta not yet answered by agent audio (for the latency metric) */
  private awaitingReplySince = 0;
  private replyLatencies: number[] = [];
  private _phase: CallPhase = "idle";
  /** set once, by the first hangup/stop; every later caller waits on the same wrap-up */
  private stopping: Promise<void> | null = null;
  /** aborts Live's connection attempt when the call ends or it takes too long */
  private connecting = new AbortController();
  private answeredAt = 0;
  /** when the call was hung up (wall clock); duration and cost stop here, not after the wrap-up */
  private endedAt = 0;
  /** caller audio that arrived while Live was still connecting (sent once it's up) */
  private earlyCallerAudio: string[] = [];

  constructor(private d: CallSessionDeps) {
    this.orch = new Orchestrator({
      meta: d.meta,
      config: d.config,
      classifier: d.classifier,
      agent: d.agent,
      bus: d.bus,
      notifier: d.notifier,
      clock: d.clock,
      dryRun: d.dryRun,
      steer: {
        tellLive: (m) => this.tellLive(m),
        hangup: (reason) => this.hangupAfterGoodbye(reason),
      },
    });
  }

  get callId() {
    return this.d.meta.callId;
  }

  get phase(): CallPhase {
    return this._phase;
  }

  private get stopped(): boolean {
    return this._phase === "stopping" || this._phase === "finalized";
  }

  /** The wrap-up after hangup, once the call has ended; null while it's live. */
  get finished(): Promise<void> | null {
    return this.stopping;
  }

  private note(level: "info" | "warn" | "error", message: string) {
    this.d.bus.publish({ type: "note", callId: this.callId, at: this.orch.elapsed(), level, message });
  }

  /** `codec` is what the media leg was answered with (config may have changed since). */
  async start(codec: AudioFormat) {
    if (this._phase !== "idle") throw new Error(`call ${this.callId} already started`);
    this._phase = "connecting";
    const cfg = this.d.config();
    this.codec = codec;
    this.answeredAt = this.d.clock.now();
    // The deadline runs from answer, so a Live connection that stalls can't keep the call open.
    // time_up asks for the goodbye first; at the deadline the call ends once it has played.
    const maxMs = cfg.flow.timing.max_call_seconds * 1000;
    const timeUpMs = cfg.flow.timing.time_up ? maxMs - cfg.flow.timing.time_up.seconds_left * 1000 : 0;
    if (timeUpMs > 0) this.timeUpTimer = setTimeout(() => this.orch.timeUp(), timeUpMs);
    this.maxTimer = setTimeout(() => {
      void this.hangupAfterGoodbye("max call length reached");
      // Backstop: the goodbye check only runs while the call is active.
      this.maxTimer = setTimeout(() => void this.hangup("max call length reached"), cfg.flow.timing.agent_idle.max_hangup_wait_ms + 1000);
    }, maxMs);

    // Say hello straight away with the recorded greeting; Live connects meanwhile and carries on from it.
    // Not over OpenAI SIP: the phone leg is OpenAI's, so there is nowhere to play it.
    const greeting = cfg.live.greeting && !this.d.mediaViaVoice && isCodec(codec) ? this.d.greetings?.get(codec) : null;
    if (greeting) {
      const chunk = 100 * BYTES_PER_MS[codec];
      for (let o = 0; o < greeting.length; o += chunk) this.onAgentAudio(b64encode(greeting.subarray(o, o + chunk)));
      this.orch.onTranscriptDelta("agent", "greeting", cfg.live.greeting);
      this.orch.onTranscriptDone("agent", "greeting");
    }

    const timeoutMs = cfg.connection.connect_timeout_ms;
    const connectTimer = setTimeout(
      () => this.connecting.abort(new Error(`Live didn't connect within ${timeoutMs} ms`)),
      timeoutMs,
    );
    let voice: VoiceSession;
    try {
      voice = await this.d.voice.connect(
        {
          config: { ...cfg.live, instructions: fillCurrentTime(cfg.live.instructions, this.answeredAt) },
          codec: this.codec,
          greeted: greeting ? cfg.live.greeting : undefined,
          signal: this.connecting.signal,
        },
        this.voiceHandlers(),
      );
    } catch (err) {
      // Hung up while connecting: connect() was aborted, nothing more to do.
      if (this.stopped) return;
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }
    if (this.stopped) {
      // Caller hung up as the voice session came up. Awaited, so the attach (which shutdown
      // waits for) covers the close and the recording it hands over; finalize waits for it too.
      this.voice = voice;
      await voice.close();
      return;
    }
    this.voice = voice;
    this._phase = "active";
    // What the caller said over the greeting, while Live was connecting.
    for (const b64 of this.earlyCallerAudio.splice(0)) this.voice.sendAudio(b64);

    this.lastActivityAt = Math.max(this.lastActivityAt, this.d.clock.now());
    this.callerAudioAt = this.d.clock.now();
    this.pollTimer = setInterval(() => {
      this.keepInputRunning();
      this.orch.poll();
      this.flushHeldInstructions();
      this.checkPendingHangup();
      this.checkSilence();
    }, 100);
  }

  private voiceHandlers(): VoiceSessionHandlers {
    return {
      onAudio: (b64) => this.onAgentAudio(b64),
      // OpenAI SIP: the caller's audio goes straight to Live; the sideband's copy drives the
      // silence watchdog and steering holds, like media-leg audio does.
      onCallerAudio: (b64) => {
        if (this.stopped) return;
        this.callerAudioAt = this.d.clock.now();
        this.detectCallerSpeech(b64decode(b64));
      },
      onTranscriptDelta: (s, id, delta) => {
        if (s === "caller") {
          this.lastActivityAt = Math.max(this.lastActivityAt, this.d.clock.now());
          this.awaitingReplySince = this.lastActivityAt;
          this.silencePrompts = 0;
        }
        this.orch.onTranscriptDelta(s, id, delta);
      },
      onTranscriptDone: (s, id, text) => this.orch.onTranscriptDone(s, id, text),
      onInterrupt: () => {
        this.d.media.clear();
        // Queued agent audio is dropped, so it no longer counts as talking.
        this.agentPlayoutUntil = this.agentSpeechUntil = this.d.clock.now();
        this.lastActivityAt = Math.min(this.lastActivityAt, this.agentPlayoutUntil);
      },
      // Luna's answer goes out through the steering queue with the delegation's id.
      onDelegation: (req) => void this.orch.delegate(req),
      onUsage: (u) => this.onUsage(u.seconds, u.contextRatio),
      onError: (err) => this.note("error", err.message),
      onClose: () => {
        // While connecting, a failed connect rejects instead (and says why).
        if (this._phase === "active") void this.hangup("voice session closed");
      },
    };
  }

  /** Caller audio from the media leg, already in the voice session's format. */
  onCallerAudio(b64: string) {
    if (this.stopped) return;
    this.callerAudioAt = this.d.clock.now();
    this.stalledSince = null;
    if (this.voice) this.voice.sendAudio(b64);
    else if (this.earlyCallerAudio.length < EARLY_AUDIO_MAX_FRAMES) this.earlyCallerAudio.push(b64);
    this.detectCallerSpeech(b64decode(b64));
  }

  /**
   * Caller transcripts arrive seconds after the words, so the silence watchdog and steering
   * holds listen to the audio itself: without this the agent was asked "are you still there?"
   * while the caller talked, and instructions cut off the reply Live was about to give.
   */
  private detectCallerSpeech(bytes: Uint8Array) {
    if (levelDbfs(bytes, this.codec) >= this.d.config().connection.speech_detection.caller_dbfs) {
      this.callerSpeechAt = this.callerAudioAt;
      this.lastActivityAt = Math.max(this.lastActivityAt, this.callerAudioAt);
    }
  }

  /**
   * gpt-live-1 only advances (hears, speaks, applies appended instructions) while input audio
   * keeps arriving. If the media leg stalls, feed it silence so the call doesn't freeze, and
   * warn once: a leg that never sends audio is a bug (e.g. an out-of-date test-call page).
   * Public for tests.
   */
  keepInputRunning() {
    if (this.stopped || !this.voice || this.d.mediaViaVoice) return;
    const now = this.d.clock.now();
    const gap = now - this.callerAudioAt;
    if (gap < 200) return;
    this.stalledSince ??= this.callerAudioAt;
    if (!this.stallWarned && now - this.stalledSince >= 1000) {
      this.stallWarned = true;
      this.note("warn", "no audio from the caller for 1 s; sending silence to keep Live running");
    }
    const ms = Math.min(gap, 1000);
    this.voice.sendAudio(b64encode(new Uint8Array(ms * BYTES_PER_MS[this.codec]).fill(SILENCE_BYTE[this.codec])));
    this.callerAudioAt = now;
  }

  /** Agent audio goes straight to the media leg; gpt-live-1 handles interruptions itself. */
  private onAgentAudio(b64: string) {
    if (this.stopped) return;
    this.d.media.sendAudio(b64);
    const bytes = b64decode(b64);
    const now = this.d.clock.now();
    this.agentPlayoutUntil = Math.max(now, this.agentPlayoutUntil) + bytes.length / BYTES_PER_MS[this.codec];
    // Live streams continuously, padding pauses with silence or faint noise; only speech counts.
    if (levelDbfs(bytes, this.codec) < this.d.config().connection.speech_detection.agent_dbfs) return;
    this.agentSpeechUntil = this.agentPlayoutUntil;
    this.agentSpeechAt = now;
    this.lastActivityAt = Math.max(this.lastActivityAt, this.agentPlayoutUntil);
    if (this.awaitingReplySince) {
      // Upper bound on turn latency: caller transcripts lag the speech, so this is caller's last
      // transcribed words → first agent audio back from Live.
      this.replyLatencies.push(now - this.awaitingReplySince);
      this.orch.onAgentReply(now - this.awaitingReplySince);
      this.awaitingReplySince = 0;
    }
  }

  /**
   * "An appended instruction can interrupt the model's current speech or behavior"
   * (live-delegation guide). Measured: an instructions append cuts the agent off mid-sentence,
   * and one sent just after the caller stops (when Jev's result lands) cancels the reply Live was
   * about to give. So `send: when_agent_idle` texts wait until the agent is idle; `send: now`
   * goes out at once.
   */
  private tellLive(m: Steer) {
    const now = this.d.clock.now();
    if (m.key) {
      // e.g. an older stage text still waiting: the newer one replaces it
      for (const h of this.held.filter((h) => h.steer.key === m.key)) this.appended(h.steer, now - h.since, true);
      this.held = this.held.filter((h) => h.steer.key !== m.key);
    }
    if (m.message.send === "now") return this.sendToLive([{ steer: m, since: now }]);
    this.held.push({ steer: m, since: now });
    this.flushHeldInstructions();
  }

  /** The agent is speaking, or the caller spoke and the agent is about to reply. */
  private agentBusy(): boolean {
    const now = this.d.clock.now();
    const st = this.d.config().flow.timing.agent_idle;
    if (now < this.agentSpeechUntil + st.agent_pause_ms) return true;
    // The caller spoke and the agent hasn't started replying yet.
    const awaitingReply = this.callerSpeechAt > this.agentSpeechAt;
    return awaitingReply && now - this.callerSpeechAt < st.reply_window_ms;
  }

  /** Sends held messages once the agent is idle, or each once its max_hold_ms is up. Public for tests. */
  flushHeldInstructions() {
    if (!this.held.length) return;
    const now = this.d.clock.now();
    const busy = this.agentBusy();
    const due = this.held.filter(({ steer, since }) => {
      const cap = steer.message.max_hold_ms;
      return !busy || (cap !== null && now - since >= cap);
    });
    if (!due.length) return;
    this.held = this.held.filter((h) => !due.includes(h));
    this.sendToLive(due);
  }

  /** Appends to Live, dropping what a newer decision superseded. */
  private sendToLive(items: { steer: Steer; since: number }[]) {
    // A decision made since supersedes guidance; a delegation must still be answered, so it gets
    // its fallback instead.
    const rev = this.orch.revision;
    const now = this.d.clock.now();
    let sent = false;
    for (const { steer, since } of items) {
      const current = steer.rev === undefined || steer.rev >= rev;
      if (!current && !steer.delegation) {
        this.appended(steer, now - since, true);
        continue;
      }
      const m = current ? steer : { ...steer, message: steer.delegation!.fallback };
      this.voice?.append(m.message.as, m.message.text, m.delegation?.id);
      this.appended(m, now - since, false, !current);
      sent = true;
    }
    // Give Live time to act on it: a silence prompt right after one pre-empted a supervisor step.
    if (sent) this.lastActivityAt = Math.max(this.lastActivityAt, now);
  }

  /** Records a text sent to Live (or dropped) for the timeline. */
  private appended(s: Steer, heldMs: number, dropped: boolean, fallback = false) {
    fallback ||= s.delegation !== undefined && s.message === s.delegation.fallback;
    this.d.bus.publish({
      type: "live.append",
      callId: this.callId,
      at: this.orch.elapsed(),
      as: s.message.as,
      text: s.message.text,
      source: s.source ?? "stage",
      ...(s.stage ? { stage: s.stage } : {}),
      heldMs,
      ...(s.delegation ? { delegationId: s.delegation.id } : {}),
      ...(fallback ? { fallback } : {}),
      ...(dropped ? { dropped } : {}),
    });
  }

  /**
   * Stores every usage report (the timeline shows the context share next to each steering
   * entry). Live compacts its history when the context passes 90%: a replacement engine gets the
   * startup instructions and ≤ 8,192 tokens of history, so appended texts may be lost
   * (https://developers.openai.com/api/docs/guides/live-conversations). The ratio drops when
   * that happens.
   */
  private onUsage(seconds: number, contextRatio?: number) {
    if (this.stopped) return;
    this.d.bus.publish({ type: "live.usage", callId: this.callId, at: this.orch.elapsed(), seconds, contextRatio });
    if (contextRatio === undefined) return;
    const prev = this.contextRatio;
    this.contextRatio = contextRatio;
    if (prev !== undefined && contextRatio < prev) {
      this.note(
        "warn",
        `Live context fell from ${pct(prev)} to ${pct(contextRatio)}: it probably compacted older history, and earlier appends may be gone`,
      );
    }
  }

  /**
   * gpt-live-1 waits quietly when nobody speaks, and has no idle setting, so after a silent
   * period we tell it to check the caller is still there. Public for tests.
   */
  checkSilence() {
    const cfg = this.d.config();
    const sc = cfg.flow.silence;
    // A hangup waiting for the goodbye: don't ask whether the caller is still there.
    if (this.stopped || !sc.enabled || this.pendingHangup) return;
    if (this.d.clock.now() - this.lastActivityAt < sc.after_ms) return;
    this.lastActivityAt = this.d.clock.now();
    const stage = this.orch.stage;
    if (stage !== null && sc.hang_up_in.includes(stage)) {
      // e.g. the goodbyes are done: don't ask "are you still there?", just end the call.
      void this.hangup(`silence after ${stage.replaceAll("_", " ")}`);
    } else if (this.silencePrompts < sc.max_prompts) {
      this.silencePrompts++;
      this.tellLive({ message: sc.tell_live, source: "silence" });
      this.note("info", `silence: prompted the caller (${this.silencePrompts}/${sc.max_prompts})`);
    } else if (sc.hang_up) {
      void this.hangup("silent line");
    }
  }

  /**
   * Hangup asked for by the call flow (e.g. the caller said to hang up) or Luna: let the agent's
   * goodbye play out first, as it usually replies "Alright, I'll end the call now".
   */
  private hangupAfterGoodbye(reason: string): Promise<void> {
    if (this.pendingHangup) return this.pendingHangup.done;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.pendingHangup = { reason, since: this.d.clock.now(), done, resolve };
    this.checkPendingHangup();
    return done;
  }

  /** Public for tests. */
  checkPendingHangup() {
    const p = this.pendingHangup;
    if (!p) return;
    const waited = this.d.clock.now() - p.since;
    if (this.agentBusy() && waited < this.d.config().flow.timing.agent_idle.max_hangup_wait_ms) return;
    this.pendingHangup = null;
    void this.hangup(p.reason).then(p.resolve);
  }

  /** Hangs up at the carrier, then ends the session. Every call returns the same wrap-up. */
  hangup(reason: string): Promise<void> {
    return this.end(reason, true);
  }

  /** Ends the session (the phone leg is gone already): hangup webhook, media close, or guards. */
  stop(reason: string): Promise<void> {
    return this.end(reason, false);
  }

  private end(reason: string, hangUpPhone: boolean): Promise<void> {
    if (this.stopping) return this.stopping;
    let begin!: () => void;
    let phoneDown: Promise<void> | undefined;
    // Assigned before anything below can call back in here (e.g. aborting the connect closes Live).
    this.stopping = new Promise<void>((r) => (begin = r)).then(() => this.finalize(reason, phoneDown));
    this._phase = "stopping";
    this.endedAt = this.d.clock.now();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.timeUpTimer) clearTimeout(this.timeUpTimer);
    this.connecting.abort(new Error("call ended"));
    this.orch.end();
    // A hangup still waiting for the goodbye is this one.
    const pending = this.pendingHangup;
    this.pendingHangup = null;
    if (pending) void this.stopping.then(pending.resolve);
    if (hangUpPhone) {
      phoneDown = this.d.telephony.hangup(this.d.callControlId).catch((err) => {
        this.note("error", `hangup failed: ${errMsg(err)}`);
      });
    }
    begin();
    return this.stopping;
  }

  private async finalize(reason: string, phoneDown: Promise<void> | undefined) {
    const cfg = this.d.config();
    // The phone leg goes down before the voice session closes, but a carrier request that hangs
    // mustn't keep the session (and shutdown) from cleaning up.
    const timeoutMs = cfg.connection.hangup_timeout_ms;
    if (phoneDown && !(await settlesWithin(phoneDown, timeoutMs))) {
      this.note("warn", `carrier hangup still pending after ${timeoutMs} ms; closing the session anyway`);
    }
    void this.voice?.close();
    this.d.media.close();

    // Let a running Luna call finish first, so call.ended and the summary include what it did.
    await this.orch.drain(cfg.luna.drain_timeout_ms);
    const minutes = this.answeredAt ? (this.endedAt - this.answeredAt) / 60000 : 0;
    const c = cfg.cost;
    const costUsd =
      minutes * c.live_usd_per_min +
      this.orch.lunaCalls * c.luna_usd_per_call +
      (this.orch.jevInputTokens / 1e6) * c.jev_usd_per_mtok;
    this.d.bus.publish({
      type: "call.ended",
      callId: this.callId,
      at: this.endedAt - this.d.meta.startedAt,
      endedAt: this.endedAt,
      reason,
      costUsd: Math.round(costUsd * 10000) / 10000,
      lunaCalls: this.orch.lunaCalls,
      jevTicks: this.orch.jevTicks,
    });
    console.log(
      `[call ${this.callId}] ended (${reason}): ${minutes.toFixed(1)} min, ${this.orch.jevTicks} Jev ticks, ` +
        `${this.orch.lunaCalls} Luna calls, est. $${costUsd.toFixed(3)}`,
    );
    if (this.replyLatencies.length) {
      const sorted = [...this.replyLatencies].sort((a, b) => a - b);
      const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
      console.log(
        `[call ${this.callId}] agent reply latency (last caller transcript → first agent audio): ` +
          `median ${q(0.5)} ms, p90 ${q(0.9)} ms over ${sorted.length} replies`,
      );
    }
    this.d.onStopped?.(this.callId);

    const transcript = this.orch.transcript.all();
    if (cfg.luna.summarize_on_hangup && transcript.some((e) => e.speaker === "caller")) {
      try {
        const reason = "summarise the call";
        this.d.bus.publish({ type: "luna.started", callId: this.callId, at: this.orch.elapsed(), reason, trigger: "summary" });
        const text = await this.d.agent.summarize(this.d.meta, transcript, { previousResponseId: this.orch.lunaResponseId });
        if (text) this.d.bus.publish({ type: "summary", callId: this.callId, at: this.orch.elapsed(), text });
        await this.sendSummary(text);
      } catch (err) {
        this.note("warn", `summary failed: ${errMsg(err)}`);
        await this.sendSummary("");
      }
    }
    // The voice session has shut down and handed over its recording (OpenAI SIP). Read again
    // here: one that finished connecting during hangup is closed by start().
    await this.voice?.close();
    this._phase = "finalized";
  }

  /** The end-of-call summary to the owner on Telegram (luna.yaml summary_to_owner). */
  private async sendSummary(summary: string) {
    const opts = this.d.config().luna.summary_to_owner;
    const verdict = this.orch.lastClassification?.verdict;
    if (!opts.enabled || !this.d.notifier || (verdict && opts.skip_verdicts.includes(verdict))) return;
    if (this.d.dryRun) return this.note("info", "summary not sent to the owner (dry run)");
    const secs = this.answeredAt ? Math.round((this.endedAt - this.answeredAt) / 1000) : 0;
    const text = [
      `📞 ${this.d.meta.from || "unknown caller"} · ${verdict ?? "no verdict"} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
      summary || "No summary; see the call page.",
      this.d.callLink?.(this.callId),
    ].filter(Boolean).join("\n\n");
    try {
      await this.d.notifier.send(text.slice(0, MAX_TELEGRAM_CHARS));
      this.note("info", "summary sent to the owner on Telegram");
    } catch (err) {
      this.note("warn", `summary not sent to the owner: ${errMsg(err)}`);
    }
  }
}

/** Telegram's limit for a message's text */
const MAX_TELEGRAM_CHARS = 4096;

/** Whether `p` settles within `ms` (it is left running either way). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
