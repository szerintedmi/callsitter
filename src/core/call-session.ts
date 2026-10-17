import { b64decode, b64encode, BYTES_PER_MS, isCodec, levelDbfs, SILENCE_BYTE, type AudioFormat, type Codec } from "./audio";
import { liveInstructions, ownerAppendText, TIME_UP, type AppConfig, type LiveAppend } from "./config";
import { logger } from "./log";
import { errMsg, Orchestrator, type Steer } from "./orchestrator";
import { SpeechTrace } from "./speech-trace";
import { OwnerBridge } from "./takeover";
import type {
  Agent,
  CallRecording,
  Classifier,
  Clock,
  EventBus,
  MediaChannel,
  OwnerAudioLeg,
  OwnerPageStats,
  TakeoverHandle,
  Telephony,
  VoiceAgent,
  VoiceSession,
  VoiceSessionHandlers,
} from "./ports";
import type { CallMeta, EndedBy } from "./types";

const log = logger("call");
const takeoverLog = logger("takeover");

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
  /** whether the owner sees status messages (OwnerDesk); Luna's rolling summaries are written for them */
  ownerStatus?: () => boolean;
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

/** Whether the owner's message went out (steerFromOwner), or why it didn't. */
export type OwnerSteerResult = { ok: true } | { ok: false; reason: string };

/** The call's new length limit once the owner extended it (extendFromOwner), or why not. */
export type OwnerExtendResult = { ok: true; maxCallSeconds: number } | { ok: false; reason: string };

/** caller audio kept while Live connects (~10 s of 20 ms frames) */
const EARLY_AUDIO_MAX_FRAMES = 500;

/** Live's session.closed reasons: who ended the call, and how the end reason says it. */
const LIVE_CLOSED: Record<string, { by: EndedBy; text: string }> = {
  remote_hangup: { by: "caller", text: "caller hung up" },
  content: { by: "live", text: "OpenAI safety filter" },
  expired: { by: "live", text: "session time limit" },
  connection_lost: { by: "live", text: "connection lost" },
  close_requested: { by: "live", text: "closed on request" },
};

/**
 * idle → connecting (Live connecting, greeting playing) → active → stopping (hung up: Luna
 * draining, summary) → finalized. The call deadline runs from connecting on. The owner's takeover
 * (telegram.yaml takeover): active → handing_over (the handover line, then the REFER and the
 * transferred leg connecting; back to active if it fails) → taken_over (the owner talks, the bot
 * is out) → stopping.
 */
export type CallPhase = "idle" | "connecting" | "active" | "handing_over" | "taken_over" | "stopping" | "finalized";

/** One takeover, from the owner's button press on. */
interface Takeover {
  /** the owner's page; null while it's gone (reconnect_grace_ms) */
  leg: OwnerAudioLeg | null;
  /** bumped per page connection, so an old handle goes quiet */
  gen: number;
  /** what the current page presents to reconnect (TakeoverHandle.reconnectToken); new per connection */
  reconnectToken: string;
  /** the REFER went out (OpenAI SIP): Live's session closing is expected from here on */
  referred: boolean;
  /** the transferred leg's call control id, once Telnyx has offered it */
  callControlId?: string;
  bridge: OwnerBridge | null;
  /** each page connection's latest counters (TakeoverHandle.pageStats), by gen */
  pageStats: Map<number, OwnerPageStats>;
  legTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  capTimer?: ReturnType<typeof setTimeout>;
}

export class CallSession {
  readonly orch: Orchestrator;
  private voice: VoiceSession | null = null;
  private codec: AudioFormat = "pcmu";
  /** drives the classification trigger and the silence watchdog */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private timeUpTimer: ReturnType<typeof setTimeout> | null = null;
  /** time_up or the deadline has come: the agent is saying goodbye, so the call can't be extended */
  private timeIsUp = false;
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
  /** the owner's last message or stage button from Telegram (wall clock) */
  private ownerSteerAt = -Infinity;
  /** a hangup the call flow or Luna asked for, waiting for the agent's goodbye to play out */
  private pendingHangup: { reason: string; by: EndedBy; since: number; done: Promise<void>; resolve: () => void } | null = null;
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
  /** Live's billed seconds, once call.ended has gone out with them (later costs events reuse them) */
  private billedLiveSeconds: number | undefined;
  /** caller audio that arrived while Live was still connecting (sent once it's up) */
  private earlyCallerAudio: string[] = [];
  /** OpenAI SIP: what the watchdog heard, logged for checking against a recording */
  private trace: SpeechTrace | null;
  /** the owner's takeover, from the button press until the call ends (null again if it failed) */
  private takeover: Takeover | null = null;
  /** when Live's part of the call ended (takeover): it's billed up to here, not to the hangup */
  private liveEndedAt = 0;
  /** when the owner took over (wall clock) */
  private takenOverAt = 0;
  /** Live's session closed while handing over (after the REFER, as expected) */
  private voiceGone = false;
  /** the voice session's recording, kept going through the takeover; handed over at the end */
  private keptRecording: CallRecording | null = null;

  constructor(private d: CallSessionDeps) {
    this.orch = new Orchestrator({
      meta: d.meta,
      config: d.config,
      classifier: d.classifier,
      agent: d.agent,
      bus: d.bus,
      ownerStatus: d.ownerStatus,
      clock: d.clock,
      dryRun: d.dryRun,
      steer: {
        tellLive: (m) => this.tellLive(m),
        hangup: (reason) => this.hangupAfterGoodbye(reason, "bot"),
      },
    });
    this.trace = d.mediaViaVoice ? new SpeechTrace(d.meta.callId) : null;
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

  /**
   * The carrier's bill for the phone leg, which arrives after the hangup. Before call.ended it
   * rides along with it; after, it goes out as a costs event.
   */
  setCarrierCost(usd: number) {
    this.orch.costs.carrierUsd = usd;
    if (this.billedLiveSeconds !== undefined) {
      this.d.bus.publish({ type: "costs", callId: this.callId, at: this.orch.elapsed(), costs: this.orch.costs.total(this.billedLiveSeconds) });
    }
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
    this.scheduleDeadline();

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
          config: { ...cfg.live, instructions: liveInstructions(cfg, this.answeredAt, this.d.meta.from) },
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
    this.startPolling();
  }

  private startPolling() {
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
        if (this.stopped || this._phase === "taken_over") return;
        this.callerAudioAt = this.d.clock.now();
        const bytes = b64decode(b64);
        this.trace?.callerAudio(this.orch.elapsed(), bytes.length / BYTES_PER_MS[this.codec]);
        this.detectCallerSpeech(bytes);
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
        // Taken over: the media leg plays the owner now.
        if (this._phase === "taken_over") return;
        this.d.media.clear();
        // Queued agent audio is dropped, so it no longer counts as talking.
        this.agentPlayoutUntil = this.agentSpeechUntil = this.d.clock.now();
        this.lastActivityAt = Math.min(this.lastActivityAt, this.agentPlayoutUntil);
      },
      // Luna's answer goes out through the steering queue with the delegation's id.
      onDelegation: (req) => void this.orch.delegate(req),
      onUsage: (u) => this.onUsage(u.seconds, u.contextRatio),
      onError: (err) => {
        // Once the call has moved on (takeover), Live's session going away is expected.
        if (this._phase !== "taken_over" && !this.takeover?.referred) this.note("error", err.message);
      },
      onClose: (reason) => {
        // The REFER ends Live's session: the call goes on, on the transferred leg.
        if (this.takeover?.referred || this._phase === "taken_over") {
          this.voiceGone = true;
          return;
        }
        // While connecting, a failed connect rejects instead (and says why). Handing over: the
        // caller hung up during the handover line, so the call ends.
        if (this._phase !== "active" && this._phase !== "handing_over") return;
        const known = reason ? LIVE_CLOSED[reason] : undefined;
        const why = reason ? `voice session closed: ${known?.text ?? reason.replaceAll("_", " ")} (${reason})` : "voice session closed";
        const by = known?.by ?? "live";
        // OpenAI SIP and WebRTC: the phone leg is Live's own, so once Live has ended the session
        // there is nothing to hang up (asking OpenAI to hang up a closed session stalls for > 5 s).
        if (reason && this.d.mediaViaVoice) void this.stop(why, by);
        else void this.hangup(why, by);
      },
    };
  }

  /** Caller audio from the media leg, already in the voice session's format (taken over: the transferred leg's). */
  onCallerAudio(b64: string) {
    if (this.stopped) return;
    if (this._phase === "taken_over") {
      const t = this.takeover!;
      const pcm = t.bridge!.callerAudio(b64);
      t.leg?.sendAudio(pcm);
      return;
    }
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
    const dbfs = levelDbfs(bytes, this.codec);
    if (dbfs >= this.d.config().connection.speech_detection.caller_dbfs) {
      this.callerSpeechAt = this.callerAudioAt;
      this.lastActivityAt = Math.max(this.lastActivityAt, this.callerAudioAt);
      this.trace?.speech("caller", this.orch.elapsed(), bytes.length / BYTES_PER_MS[this.codec], dbfs);
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
    // Taken over: what Live still sends as it closes mustn't reach the caller.
    if (this.stopped || this._phase === "taken_over") return;
    this.d.media.sendAudio(b64);
    const bytes = b64decode(b64);
    const now = this.d.clock.now();
    this.agentPlayoutUntil = Math.max(now, this.agentPlayoutUntil) + bytes.length / BYTES_PER_MS[this.codec];
    // Live streams continuously, padding pauses with silence or faint noise; only speech counts.
    const dbfs = levelDbfs(bytes, this.codec);
    if (dbfs < this.d.config().connection.speech_detection.agent_dbfs) return;
    this.trace?.speech("agent", this.orch.elapsed(), bytes.length / BYTES_PER_MS[this.codec], dbfs);
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
    // Taken over: Live is gone (a Luna answer still in flight, say).
    if (this._phase === "taken_over") return this.appended(m, 0, true);
    if (m.key) {
      // e.g. an older stage text still waiting: the newer one replaces it, unless it's the owner's
      // stage button and this one is held for the owner
      const replaced = this.held.filter((h) => h.steer.key === m.key && !(h.steer.byOwner && this.heldForOwner(m)));
      for (const h of replaced) this.appended(h.steer, now - h.since, true);
      this.held = this.held.filter((h) => !replaced.includes(h));
    }
    if (m.message.send === "now" && !this.heldForOwner(m)) return this.sendToLive([{ steer: m, since: now }]);
    this.held.push({ steer: m, since: now });
    this.flushHeldInstructions();
  }

  /**
   * The owner's message from Telegram (telegram.yaml steering), sent to Live as `as` in
   * steering.text. It goes out at once and is never dropped as stale; Luna sees it from her next
   * run on.
   */
  steerFromOwner(message: string, as: LiveAppend): OwnerSteerResult {
    const st = this.d.config().telegram.steering;
    if (!st.enabled) return { ok: false, reason: "steering is turned off (telegram.yaml)" };
    if (this.stopped) return { ok: false, reason: "that call has ended" };
    if (this.takeover) return { ok: false, reason: TAKEN_OVER };
    if (this._phase !== "active") return { ok: false, reason: "the call isn't connected yet" };
    const text = message.trim();
    if (!text) return { ok: false, reason: "the message is empty" };
    this.orch.ownerSteered(text);
    this.ownerSteerAt = this.d.clock.now();
    this.tellLive({ message: { as, text: ownerAppendText(st, text), send: "now", max_hold_ms: null }, source: "owner" });
    return { ok: true };
  }

  /**
   * The owner's stage button (telegram.yaml steering.buttons): the call enters that call-flow
   * stage, and Live gets the rule's tell_live as the call flow would send it.
   */
  stageFromOwner(stage: string, label: string): OwnerSteerResult {
    if (!this.d.config().telegram.steering.enabled) return { ok: false, reason: "steering is turned off (telegram.yaml)" };
    if (this.stopped) return { ok: false, reason: "that call has ended" };
    if (this.takeover) return { ok: false, reason: TAKEN_OVER };
    if (this._phase !== "active") return { ok: false, reason: "the call isn't connected yet" };
    if (!this.orch.enterStage(stage, label)) return { ok: false, reason: `there's no ${stage} stage in call-flow.yaml` };
    this.ownerSteerAt = this.d.clock.now();
    return { ok: true };
  }

  /**
   * The owner ended the call from Telegram: it hangs up once the agent's goodbye (a steering text
   * sent just before) has played, like the call flow's hang-ups.
   */
  hangUpFromOwner(): OwnerSteerResult {
    if (this.stopped) return { ok: false, reason: "that call has ended" };
    // Taken over (or handing over): no goodbye from the agent, it's the owner's call now.
    if (this.takeover) {
      void this.hangup("the owner hung up from Telegram", "owner");
      return { ok: true };
    }
    if (this._phase !== "active") return { ok: false, reason: "the call isn't connected yet" };
    void this.hangupAfterGoodbye("the owner hung up from Telegram", "owner");
    return { ok: true };
  }

  /**
   * The owner's extend button (telegram.yaml steering.buttons extend_minutes): the call may run
   * that much longer. Taps add up. Too late once the agent has been told to say goodbye.
   */
  extendFromOwner(minutes: number): OwnerExtendResult {
    if (!this.d.config().telegram.steering.enabled) return { ok: false, reason: "steering is turned off (telegram.yaml)" };
    if (this.stopped) return { ok: false, reason: "that call has ended" };
    if (this.takeover) return { ok: false, reason: TAKEN_OVER };
    if (this.timeIsUp) return { ok: false, reason: "the agent is already saying goodbye" };
    this.orch.extendedMs += minutes * 60_000;
    this.scheduleDeadline();
    const maxCallSeconds = this.maxCallMs() / 1000;
    this.note("info", `the owner added ${minutes} min: the call can run ${Math.round(maxCallSeconds / 60)} min`);
    return { ok: true, maxCallSeconds };
  }

  /** The voice vendor carries the phone leg (OpenAI SIP): a takeover transfers it (refer). */
  get overVoice(): boolean {
    return !!this.d.mediaViaVoice;
  }

  get channel() {
    return this.d.meta.channel;
  }

  /** Taken over (or handing over), and not ended: the owner's page may (re)attach. */
  get takenOver(): boolean {
    return !!this.takeover && !this.stopped;
  }

  /** Taken over (or handing over) and the owner's page is gone, within reconnect_grace_ms. */
  get ownerAway(): boolean {
    return this.takenOver && !this.takeover!.leg;
  }

  /** Whether `token` is the current page's reconnect token (TakeoverHandle.reconnectToken). */
  reconnectTokenValid(token: string): boolean {
    const want = this.takenOver ? this.takeover!.reconnectToken : "";
    if (!want || token.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  }

  /** Why the owner can't take this call over now (telegram.yaml takeover), or null. */
  takeoverBlocked(): string | null {
    if (this.stopped) return "that call has ended";
    if (this.takeover) return "the call is already taken over";
    if (this._phase !== "active") return "the call isn't connected yet";
    if (this.pendingHangup || this.timeIsUp) return "the call is ending";
    if (this.d.mediaViaVoice && !this.voice?.refer) return "this call can't be transferred";
    return null;
  }

  /**
   * The owner takes the call over (telegram.yaml takeover) on their page, `leg`. The agent says
   * the handover line and the bot stops steering; then the call moves: over OpenAI SIP by a REFER
   * to `referTo` (its transferred leg connects through attachTakeoverLeg), over the media stream
   * at once. Returns straight away; `leg` hears how it goes.
   */
  takeOver(leg: OwnerAudioLeg, referTo: string | null): TakeoverHandle {
    const why = this.takeoverBlocked();
    if (why) throw new Error(why);
    if (!!referTo !== !!this.d.mediaViaVoice) throw new Error(referTo ? "only a call over OpenAI SIP is transferred" : "a call over OpenAI SIP needs a transfer target");
    const t: Takeover = { leg, gen: 1, reconnectToken: newToken(), referred: false, bridge: null, pageStats: new Map() };
    this.takeover = t;
    this._phase = "handing_over";
    // No Jev, watchdog or held steering while handing over; the deadline is the takeover's own.
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.timeUpTimer) clearTimeout(this.timeUpTimer);
    leg.notify({ type: "connecting" });
    this.d.bus.publish({ type: "takeover.started", callId: this.callId, at: this.orch.elapsed() });
    log.info(`owner taking over (${referTo ? "transfer" : "media stream"})`, { callId: this.callId });
    void this.handOver(t, referTo).catch((err) => {
      log.error("takeover failed", { callId: this.callId, err });
      if (this.takeover === t && this._phase === "handing_over") this.takeoverFailed(t, `takeover failed: ${errMsg(err)}`);
    });
    return this.takeoverHandle(t);
  }

  /**
   * The owner's page connects again (within reconnect_grace_ms of ownerLeft, or before its old
   * connection is known to be gone: behind a tunnel a dead socket can linger). It takes the call
   * over from the old connection, whose handle goes quiet, so its late close changes nothing.
   */
  reattachOwner(leg: OwnerAudioLeg): TakeoverHandle {
    const t = this.takeover;
    if (!t || this.stopped) throw new Error(this.stopped ? "that call has ended" : "the call isn't taken over");
    clearTimeout(t.graceTimer);
    const old = t.leg;
    t.leg = leg;
    t.gen++;
    t.reconnectToken = newToken();
    if (old) {
      old.notify({ type: "error", message: "The call moved to a newer connection." });
      old.close();
    }
    t.bridge?.ownerReconnected();
    leg.notify(this._phase === "taken_over" ? { type: "live" } : { type: "connecting" });
    this.note("info", "the owner's page reconnected");
    return this.takeoverHandle(t);
  }

  private takeoverHandle(t: Takeover): TakeoverHandle {
    const gen = t.gen;
    const current = () => this.takeover === t && t.gen === gen && !this.stopped;
    return {
      reconnectToken: t.reconnectToken,
      ownerAudio: (pcm16) => {
        if (!current() || this._phase !== "taken_over") return;
        this.d.media.sendAudio(t.bridge!.ownerAudio(pcm16));
      },
      ownerLeft: () => {
        if (!current() || !t.leg) return;
        t.leg = null;
        const grace = this.d.config().telegram.takeover.reconnect_grace_ms;
        this.note("info", `the owner's page disconnected: hanging up unless it's back within ${Math.round(grace / 1000)} s`);
        t.graceTimer = setTimeout(() => void this.hangup("the owner left the call", "owner"), grace);
      },
      // At the carrier too: the transferred leg (or, still handing over, the SIP call).
      hangUp: () => {
        if (current()) void this.hangup("the owner hung up", "owner");
      },
      // Kept per connection: a page opened again counts from zero.
      pageStats: (s) => {
        if (this.takeover === t) t.pageStats.set(gen, s);
      },
    };
  }

  private async handOver(t: Takeover, referTo: string | null) {
    const tk = this.d.config().telegram.takeover;
    this.sayNow(tk.handover_text);
    await this.waitForSpeech(this.d.clock.now(), tk.max_handover_wait_ms);
    if (this.takeover !== t || this.stopped) return;
    if (!referTo) {
      // The media stream: the leg stays, Live goes.
      this.d.media.clear();
      this.liveEndedAt = this.d.clock.now();
      this.enterTakenOver(t, this.codec as Codec);
      void this.voice?.close();
      return;
    }
    // The recording has to last the rest of the call: the leg's wait plus the takeover's limit.
    const recordFor = (this.d.clock.now() - this.answeredAt + tk.leg_timeout_ms) / 1000 + tk.max_seconds + 60;
    // Every attempt: a retry after a failed transfer needs the longer limit too (keepRecording
    // returns the same recording each time).
    this.keptRecording = this.voice?.keepRecording?.(recordFor) ?? this.keptRecording;
    t.referred = true;
    // leg_timeout_ms covers the REFER request too: a stalled one is aborted, so the call can't
    // sit handing over (no deadline, no agent) for as long as the SDK would retry.
    const abort = new AbortController();
    let accepted = false;
    t.legTimer = setTimeout(() => {
      if (this.takeover !== t || this._phase !== "handing_over") return;
      abort.abort();
      const why = accepted ? "the transferred call didn't connect" : "the transfer request timed out";
      this.d.bus.publish({ type: "takeover.failed", callId: this.callId, at: this.orch.elapsed(), reason: why });
      t.leg?.notify({ type: "error", message: why });
      // Hang up whatever holds the caller: the transferred leg if Telnyx offered it, OpenAI's
      // call if the REFER never went through; after an accepted REFER with no leg, nothing does.
      if (t.callControlId || !accepted) void this.hangup(why, "system");
      else void this.stop(why, "system");
    }, tk.leg_timeout_ms);
    try {
      await this.voice!.refer!(referTo, abort.signal);
    } catch (err) {
      // Timed out: the timer has ended the call.
      if (abort.signal.aborted) return;
      clearTimeout(t.legTimer);
      t.referred = false;
      if (this.takeover !== t || this.stopped) return;
      // A REFER that failed after the session closed anyway leaves nothing to carry on with.
      if (this.voiceGone) return void this.stop(`transfer failed and the voice session closed: ${errMsg(err)}`, "system");
      return this.takeoverFailed(t, `the transfer failed: ${errMsg(err)}`);
    }
    accepted = true;
    if (this.takeover !== t || this.stopped) return;
    // OpenAI hands the call to Telnyx now: Live's billing ends here.
    this.liveEndedAt = this.d.clock.now();
  }

  /** Sends `text` to Live as commentary at once (the agent says it in its own words). */
  private sayNow(text: string) {
    this.voice?.append("commentary", text);
    this.appended({ message: { as: "commentary", text, send: "now", max_hold_ms: null }, source: "owner" }, 0, false);
  }

  /** Until the agent has started speaking after `since` and finished, or `maxMs` has passed. */
  private waitForSpeech(since: number, maxMs: number): Promise<void> {
    const pause = this.d.config().flow.timing.agent_idle.agent_pause_ms;
    return new Promise((resolve) => {
      const check = () => {
        const now = this.d.clock.now();
        const said = this.agentSpeechAt >= since && now >= this.agentSpeechUntil + pause;
        if (this.stopped || said || now - since >= maxMs) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
  }

  /** The REFER failed: the agent carries on, and the owner's page says why. */
  private takeoverFailed(t: Takeover, reason: string) {
    clearTimeout(t.legTimer);
    clearTimeout(t.graceTimer);
    this.takeover = null;
    this._phase = "active";
    this.scheduleDeadline();
    this.startPolling();
    this.note("warn", reason);
    log.warn(`takeover failed, the agent carries on: ${reason}`, { callId: this.callId });
    this.d.bus.publish({ type: "takeover.failed", callId: this.callId, at: this.orch.elapsed(), reason });
    t.leg?.notify({ type: "error", message: reason });
    this.sayNow(this.d.config().telegram.takeover.failed_text);
  }

  /**
   * Telnyx offers the transferred leg (its call.initiated matched this call's token): from now
   * on hanging up goes to it. False if this call isn't waiting for one.
   */
  takeoverLegOffered(callControlId: string): boolean {
    const t = this.takeover;
    if (!t?.referred || t.callControlId || this._phase !== "handing_over") return false;
    t.callControlId = callControlId;
    this.d.callControlId = callControlId;
    return true;
  }

  /** The transferred leg's media stream connected: the owner talks to the caller over it. */
  attachTakeoverLeg(media: MediaChannel, codec: Codec) {
    const t = this.takeover;
    if (!t?.callControlId || this._phase !== "handing_over") throw new Error(`call ${this.callId} isn't waiting for a transferred leg`);
    clearTimeout(t.legTimer);
    this.d.media = media;
    this.d.mediaViaVoice = false;
    this.enterTakenOver(t, codec);
  }

  private enterTakenOver(t: Takeover, codec: Codec) {
    const tk = this.d.config().telegram.takeover;
    this._phase = "taken_over";
    this.takenOverAt = this.d.clock.now();
    t.bridge = new OwnerBridge(codec, this.keptRecording, this.d.clock);
    // The bot is out: no more Jev, Luna or rolling summaries.
    this.orch.end();
    this.held = [];
    t.capTimer = setTimeout(() => void this.hangup("takeover time limit reached", "system"), tk.max_seconds * 1000);
    this.d.bus.publish({ type: "takeover.live", callId: this.callId, at: this.orch.elapsed() });
    takeoverLog.info("the owner took the call over", { callId: this.callId });
    t.leg?.notify({ type: "live" });
  }

  /** max_call_seconds plus what the owner added (ms) */
  private maxCallMs(): number {
    return this.d.config().flow.timing.max_call_seconds * 1000 + this.orch.extendedMs;
  }

  /**
   * (Re)sets the call's deadline, from answer: time_up asks for the goodbye first; at the deadline
   * the call ends once it has played.
   */
  private scheduleDeadline() {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.timeUpTimer) clearTimeout(this.timeUpTimer);
    const cfg = this.d.config();
    const leftMs = this.answeredAt + this.maxCallMs() - this.d.clock.now();
    const timeUpMs = cfg.flow.timing.time_up ? leftMs - cfg.flow.timing.time_up.seconds_left * 1000 : 0;
    if (timeUpMs > 0) {
      this.timeUpTimer = setTimeout(() => {
        this.timeIsUp = true;
        this.orch.timeUp();
      }, timeUpMs);
    }
    this.maxTimer = setTimeout(() => {
      this.timeIsUp = true;
      void this.hangupAfterGoodbye("max call length reached", "bot");
      // Backstop: the goodbye check only runs while the call is active.
      const wait = cfg.flow.timing.agent_idle;
      this.maxTimer = setTimeout(() => void this.hangup("max call length reached", "bot"), wait.max_hangup_wait_ms + wait.max_goodbye_overrun_ms + 1000);
    }, Math.max(0, leftMs));
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

  /**
   * A call-flow stage text soon after the owner's message or stage button (telegram.yaml
   * steering.hold_stage_ms) waits, so it doesn't replace what the owner said; a newer stage
   * replaces it by key meanwhile. Not the owner's own stage button, nor time-up.
   */
  private heldForOwner(s: Steer): boolean {
    if (s.key !== "stage" || s.byOwner || s.stage === TIME_UP) return false;
    return this.d.clock.now() < this.ownerSteerAt + this.d.config().telegram.steering.hold_stage_ms;
  }

  /**
   * Sends held messages once the agent is idle, or each once its max_hold_ms is up; stage texts
   * held for the owner (send: now ones too) not before that's over. Public for tests.
   */
  flushHeldInstructions() {
    if (!this.held.length) return;
    const now = this.d.clock.now();
    const busy = this.agentBusy();
    const due = this.held.filter(({ steer, since }) => {
      if (this.heldForOwner(steer)) return false;
      const cap = steer.message.max_hold_ms;
      return steer.message.send === "now" || !busy || (cap !== null && now - since >= cap);
    });
    if (!due.length) return;
    this.held = this.held.filter((h) => !due.includes(h));
    this.sendToLive(due);
  }

  /** Appends to Live, dropping what a newer decision superseded. */
  private sendToLive(items: { steer: Steer; since: number }[]) {
    // A decision made since supersedes guidance; a delegation must still be answered, so it gets
    // its fallback instead.
    const now = this.d.clock.now();
    let sent = false;
    for (const { steer, since } of items) {
      const current = steer.rev === undefined || steer.rev >= (steer.delegation ? this.orch.flowRevision : this.orch.revision);
      if (!current && !steer.delegation) {
        this.appended(steer, now - since, true);
        continue;
      }
      const m: Steer = current ? steer : { ...steer, message: steer.delegation!.fallback, fallback: true };
      this.voice?.append(m.message.as, m.message.text, m.delegation?.id);
      this.appended(m, now - since, false);
      sent = true;
    }
    // Give Live time to act on it: a silence prompt right after one pre-empted a supervisor step.
    if (sent) this.lastActivityAt = Math.max(this.lastActivityAt, now);
  }

  /** Records a text sent to Live (or dropped) for the timeline. */
  private appended(s: Steer, heldMs: number, dropped: boolean) {
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
      ...(s.fallback ? { fallback: true } : {}),
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
      void this.hangup(`silence after ${stage.replaceAll("_", " ")}`, "bot");
    } else if (this.silencePrompts < sc.max_prompts) {
      this.silencePrompts++;
      this.tellLive({ message: sc.tell_live, source: "silence" });
      this.note("info", `silence: prompted the caller (${this.silencePrompts}/${sc.max_prompts})`);
    } else if (sc.hang_up) {
      void this.hangup("silent line", "bot");
    }
  }

  /**
   * Hangup asked for by the call flow (e.g. the caller said to hang up) or Luna: let the agent's
   * goodbye play out first, as it usually replies "Alright, I'll end the call now".
   */
  private hangupAfterGoodbye(reason: string, by: EndedBy): Promise<void> {
    // The call flow or Luna (a result still in flight) can't end a call the owner has taken over.
    if (this.takeover && by === "bot") return Promise.resolve();
    if (this.pendingHangup) return this.pendingHangup.done;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.pendingHangup = { reason, by, since: this.d.clock.now(), done, resolve };
    this.checkPendingHangup();
    return done;
  }

  /** Public for tests. */
  checkPendingHangup() {
    const p = this.pendingHangup;
    if (!p) return;
    const now = this.d.clock.now();
    const waited = now - p.since;
    const st = this.d.config().flow.timing.agent_idle;
    if (this.agentBusy() && waited < st.max_hangup_wait_ms) return;
    // Past the wait, still let a sentence in progress (a goodbye that started late) finish.
    if (now < this.agentSpeechUntil + st.agent_pause_ms && waited < st.max_hangup_wait_ms + st.max_goodbye_overrun_ms) return;
    this.pendingHangup = null;
    void this.hangup(p.reason, p.by).then(p.resolve);
  }

  /** Hangs up at the carrier, then ends the session. Every call returns the same wrap-up. */
  hangup(reason: string, by: EndedBy = "system"): Promise<void> {
    return this.end(reason, by, true);
  }

  /** Ends the session (the phone leg is gone already): hangup webhook, media close, or guards. */
  stop(reason: string, by: EndedBy = "system"): Promise<void> {
    return this.end(reason, by, false);
  }

  private end(reason: string, by: EndedBy, hangUpPhone: boolean): Promise<void> {
    if (this.stopping) return this.stopping;
    let begin!: () => void;
    let phoneDown: Promise<void> | undefined;
    // Assigned before anything below can call back in here (e.g. aborting the connect closes Live).
    this.stopping = new Promise<void>((r) => (begin = r)).then(() => this.finalize(reason, by, phoneDown));
    const was = this._phase;
    this._phase = "stopping";
    const t = this.takeover;
    if (t) {
      clearTimeout(t.legTimer);
      clearTimeout(t.graceTimer);
      clearTimeout(t.capTimer);
      if (was === "handing_over") this.d.bus.publish({ type: "takeover.failed", callId: this.callId, at: this.orch.elapsed(), reason: `the call ended: ${reason}` });
      t.leg?.notify({ type: "ended", reason });
      t.leg?.close();
      t.leg = null;
      if (t.bridge) {
        // How the takeover's audio went, to judge its quality afterwards.
        const { text, fields } = t.bridge.summary(t.gen - 1, [...t.pageStats.values()]);
        takeoverLog.info(text, { callId: this.callId, ...fields });
        this.note("info", text);
      }
    }
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

  private async finalize(reason: string, by: EndedBy, phoneDown: Promise<void> | undefined) {
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
    // Live bills per second of session: from answer to hangup, or to the takeover.
    const liveSeconds = this.answeredAt ? ((this.liveEndedAt || this.endedAt) - this.answeredAt) / 1000 : 0;
    const costs = this.orch.costs.total(liveSeconds);
    this.billedLiveSeconds = liveSeconds;
    this.d.bus.publish({
      type: "call.ended",
      callId: this.callId,
      at: this.endedAt - this.d.meta.startedAt,
      endedAt: this.endedAt,
      reason,
      endedBy: by,
      costUsd: Math.round(costs.totalUsd * 10000) / 10000,
      lunaCalls: costs.luna.calls,
      jevTicks: this.orch.jevTicks,
      costs,
    });
    log.info(
      `ended (${reason}): ${(liveSeconds / 60).toFixed(1)} min, ${this.orch.jevTicks} Jev ticks, ` +
        `${costs.luna.calls} Luna calls, $${costs.totalUsd.toFixed(3)}`,
      { callId: this.callId },
    );
    if (this.replyLatencies.length) {
      const sorted = [...this.replyLatencies].sort((a, b) => a - b);
      const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
      log.info(
        "agent reply latency (last caller transcript → first agent audio): " +
          `median ${q(0.5)} ms, p90 ${q(0.9)} ms over ${sorted.length} replies`,
        { callId: this.callId },
      );
    }
    const heard = this.trace?.summary();
    if (heard) this.note("info", heard);
    this.d.onStopped?.(this.callId);

    const transcript = this.orch.transcript.all();
    const last = this.orch.lastProgress;
    // Taken over: the summary says so, which the last rolling one doesn't.
    const takenOverAt = this.takenOverAt ? this.takenOverAt - this.d.meta.startedAt : undefined;
    if (last && last.callerRev === this.orch.transcript.callerRev && takenOverAt === undefined) {
      // The caller said nothing after the last rolling summary: it's the final one.
      this.d.bus.publish({ type: "summary", callId: this.callId, at: this.orch.elapsed(), text: last.summary, reused: true });
    } else if (cfg.luna.summarize_on_hangup && transcript.some((e) => e.speaker === "caller")) {
      try {
        const reason = "summarise the call";
        this.d.bus.publish({ type: "luna.started", callId: this.callId, at: this.orch.elapsed(), reason, trigger: "summary" });
        const res = await this.d.agent.summarize(this.d.meta, transcript, {
          previousResponseId: this.orch.lunaResponseId,
          ownerMessages: this.orch.ownerMessages,
          stage: this.orch.stage,
          ...(takenOverAt !== undefined ? { takenOverAt } : {}),
        });
        const usage = res.usage ? this.orch.costs.addLuna(res.usage) : undefined;
        if (res.text) this.d.bus.publish({ type: "summary", callId: this.callId, at: this.orch.elapsed(), text: res.text, ...(usage ? { usage } : {}) });
        if (usage) this.d.bus.publish({ type: "costs", callId: this.callId, at: this.orch.elapsed(), costs: this.orch.costs.total(liveSeconds) });
      } catch (err) {
        this.note("warn", `summary failed: ${errMsg(err)}`);
      }
    }
    // The voice session has shut down and handed over its recording (OpenAI SIP). Read again
    // here: one that finished connecting during hangup is closed by start(). A recording kept
    // through a takeover is handed over now.
    await this.voice?.close();
    this.keptRecording?.finish();
    this._phase = "finalized";
  }
}

const TAKEN_OVER = "you've taken this call over";

/** 128 random bits, hex */
function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
