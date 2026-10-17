import type { AudioFormat, Codec } from "./audio";
import { CallSession, type CallSessionDeps } from "./call-session";
import { withCarrier } from "./cost";
import { CallGate, callSecondsCap, type Channel, type LimitHit } from "./limits";
import { logger } from "./log";
import type { BlobStore, EventBus, MediaChannel, OwnerAudioLeg, RecordingStore, RecordingWriter, Repo, TakeoverHandle, VoiceAgent } from "./ports";
import { bufferedRecordings } from "./recording";
import { TakeoverTokens, takeoverUri } from "./takeover";
import type { CallMeta, EndedBy, SipHeader } from "./types";

// Registry of live calls plus the call lifecycle (incoming → media → hangup → recording), and
// each channel's call limits (limits.yaml, CallGate), applied to every incoming call.

export type SharedDeps = Omit<CallSessionDeps, "meta" | "callControlId" | "media" | "mediaViaVoice" | "onStopped" | "dryRun"> & {
  repo: Repo;
  blobs: BlobStore;
  /** where recordings are written while calls run (default: in memory, then put to `blobs`) */
  recordings?: RecordingStore;
  /**
   * TELNYX_TAKEOVER_SIP_DOMAIN: the Call Control app's SIP subdomain a taken-over OpenAI SIP call
   * is transferred to (telegram.yaml takeover); without it, calls can't be taken over.
   */
  takeoverSipDomain?: string;
};

export interface AttachOptions {
  dryRun?: boolean;
  /** per-call voice agent (OpenAI SIP: accept + sideband for this session) instead of the shared one */
  voice?: VoiceAgent;
  mediaViaVoice?: boolean;
}

/**
 * How long an ended call's session stays reachable for the carrier's bill (Telnyx call.cost,
 * seconds after the hangup). The session's cost meter is the truth until then: the stored costs
 * can lag behind persistence.
 */
const KEEP_ENDED_MS = 10 * 60_000;

/** For calls whose audio doesn't pass through us (OpenAI SIP): agent audio copies are dropped. */
export const NO_MEDIA: MediaChannel = { sendAudio() {}, clear() {}, close() {} };

const recLog = logger("recording");

export class CallManager {
  private sessions = new Map<string, CallSession>();
  /** sessions whose call has ended: `until` is null while the wrap-up (the summary) runs, then when to forget them */
  private ended = new Map<string, { session: CallSession; until: number | null }>();
  /** calls whose session is being set up (before it's in `sessions`), so a second attach waits for it */
  private attaching = new Map<string, Promise<CallSession>>();
  /** work that outlives a call's session (its wrap-up, saving recordings); shutdown waits for it */
  private background = new Set<Promise<unknown>>();
  /** registered calls that have no session yet (answered, media not connected) */
  private pending = new Set<string>();
  private shuttingDown = false;
  /** while set and in the future, new calls are turned away (a deploy waits for the rest to end) */
  private drainUntil: number | null = null;

  /** limits.yaml: whether a new call fits its channel's limits; a slot is released when the call ends */
  readonly gate: CallGate;
  /** what a taken-over OpenAI SIP call's transferred leg dials, to be matched to its call */
  private takeoverTokens: TakeoverTokens;
  private recordings: RecordingStore;

  constructor(private d: SharedDeps) {
    this.recordings = d.recordings ?? bufferedRecordings(d.blobs);
    this.gate = new CallGate({ repo: d.repo, config: d.config, clock: d.clock });
    this.takeoverTokens = new TakeoverTokens(d.clock);
    d.bus.subscribe((ev) => {
      if (ev.type === "call.ended") this.gate.release(ev.callId);
    });
  }

  get bus(): EventBus {
    return this.d.bus;
  }

  /** False while draining or shutting down: callers reject new calls instead of registering them. */
  get accepting(): boolean {
    if (this.shuttingDown) return false;
    return this.drainUntil === null || this.d.clock.now() >= this.drainUntil;
  }

  /** Turns new calls away for `ttlMs`, so a deploy that dies mid-drain can't leave it on. */
  drain(ttlMs: number) {
    this.drainUntil = this.d.clock.now() + ttlMs;
  }

  resume() {
    this.drainUntil = null;
  }

  /** Calls that would be cut off by a restart: registered, connecting or live. */
  get activeCalls(): number {
    return new Set([...this.pending, ...this.attaching.keys(), ...this.sessions.keys()]).size;
  }

  /**
   * Registers an incoming call, unless a limit of its channel (limits.yaml) turns it away: then it
   * isn't registered and the limit is returned. `caller` is who it counts for per caller (the
   * number, or the public page's client IP); none: not counted.
   */
  async registerIncoming(c: {
    callId: string;
    callControlId: string;
    from: string;
    to: string;
    divertedFrom?: string;
    callerIp?: string;
    channel: Channel;
    caller?: string;
  }): Promise<LimitHit | null> {
    // Checked before the first await, so a call can't slip in after a drain reports no calls.
    if (!this.accepting) throw new Error("not accepting calls (draining or shutting down)");
    this.pending.add(c.callId);
    let startedAt: number;
    try {
      const hit = await this.gate.admit({ callId: c.callId, channel: c.channel, caller: c.caller });
      if (hit) {
        this.pending.delete(c.callId);
        return hit;
      }
      startedAt = this.d.clock.now();
      await this.d.repo.createCall({
        id: c.callId,
        callControlId: c.callControlId,
        from: c.from,
        to: c.to,
        divertedFrom: c.divertedFrom ?? null,
        callerIp: c.callerIp ?? null,
        channel: c.channel,
        startedAt,
      });
    } catch (err) {
      this.pending.delete(c.callId);
      this.gate.release(c.callId);
      throw err;
    }
    const meta: CallMeta = { callId: c.callId, from: c.from, to: c.to, divertedFrom: c.divertedFrom, channel: c.channel, startedAt };
    this.d.bus.publish({ type: "call.started", callId: c.callId, meta });
    return null;
  }

  /**
   * Records a call turned away by a limit (registerIncoming's answer), after the caller has been
   * rejected: an ended row in the call list, and a call.started the owner's chat tells them about.
   */
  async declineIncoming(c: {
    callId: string;
    callControlId: string;
    from: string;
    to: string;
    divertedFrom?: string;
    channel: Channel;
    declined: LimitHit;
    reason: string;
  }) {
    const startedAt = this.d.clock.now();
    await this.d.repo.createCall({
      id: c.callId,
      callControlId: c.callControlId,
      from: c.from,
      to: c.to,
      divertedFrom: c.divertedFrom ?? null,
      channel: c.channel,
      declined: c.declined,
      startedAt,
    });
    const meta: CallMeta = { callId: c.callId, from: c.from, to: c.to, divertedFrom: c.divertedFrom, channel: c.channel, declined: c.reason, startedAt };
    this.d.bus.publish({ type: "call.started", callId: c.callId, meta });
    this.d.bus.publish({
      type: "call.ended",
      callId: c.callId,
      at: 0,
      endedAt: startedAt,
      reason: c.reason,
      endedBy: "system",
      costUsd: 0,
      lunaCalls: 0,
      jevTicks: 0,
    });
  }

  /** Why a limit turned a call on `channel` away, for the call list and the owner. */
  async declineReason(channel: Channel, hit: LimitHit): Promise<string> {
    const lim = this.d.config().limits[channel];
    const u = await this.gate.usage(channel);
    switch (hit) {
      case "budget":
        return `declined: daily spend reached ($${u.spentUsd.toFixed(2)} of $${lim.max_spend_usd_per_day} in 24 h)`;
      case "quota":
        return `declined: ${lim.max_calls_per_day} calls in 24 h reached`;
      case "per_caller":
        return `declined: this caller's ${lim.max_calls_per_caller_per_day} calls in 24 h reached`;
      case "busy":
        return `declined: ${lim.max_concurrent_calls} calls at once reached`;
    }
  }

  /** Media connected (or a SIP call arrived): start the voice session for this call. */
  async attachMedia(callId: string, media: MediaChannel, codec: AudioFormat, opts: AttachOptions = {}): Promise<CallSession> {
    const existing = this.sessions.get(callId) ?? this.attaching.get(callId);
    if (existing) return existing;
    // Reserved before the first await, so a concurrent attach can't start a second session.
    const attach = this.createSession(callId, media, codec, opts);
    this.attaching.set(callId, attach);
    try {
      return await attach;
    } finally {
      if (this.attaching.get(callId) === attach) this.attaching.delete(callId);
    }
  }

  private async createSession(callId: string, media: MediaChannel, codec: AudioFormat, opts: AttachOptions): Promise<CallSession> {
    const call = await this.d.repo.getCall(callId);
    if (!call) throw new Error(`unknown call ${callId}`);
    if (call.status === "ended") throw new Error(`call ${callId} already ended`);
    // stopAll has already hung up the sessions it saw; the next startup reaps this call.
    if (this.shuttingDown) throw new Error("server shutting down");

    // The channel's limits.yaml max_call_seconds caps the call flow's.
    const config = () => {
      const cfg = this.d.config();
      const max = callSecondsCap(cfg, call.channel);
      if (max === cfg.flow.timing.max_call_seconds) return cfg;
      return { ...cfg, flow: { ...cfg.flow, timing: { ...cfg.flow.timing, max_call_seconds: max } } };
    };
    const session = new CallSession({
      ...this.d,
      config,
      meta: {
        callId,
        from: call.from,
        to: call.to,
        divertedFrom: call.divertedFrom ?? undefined,
        channel: call.channel,
        startedAt: call.startedAt,
      },
      callControlId: call.callControlId,
      media,
      voice: opts.voice ?? this.d.voice,
      mediaViaVoice: opts.mediaViaVoice,
      dryRun: opts.dryRun,
      onStopped: () => {
        if (this.sessions.get(callId) === session) this.sessions.delete(callId);
        this.takeoverTokens.revoke(callId);
        // The summary is still to come.
        if (session.finished) {
          const entry = { session, until: null as number | null };
          this.ended.set(callId, entry);
          const wrapped = () => void (entry.until = this.d.clock.now() + KEEP_ENDED_MS);
          this.track(session.finished).then(wrapped, wrapped);
          this.pruneEnded();
        }
      },
    });
    this.sessions.set(callId, session);
    this.pending.delete(callId);
    await this.d.repo.updateCall(callId, { status: "active" });
    try {
      await session.start(codec);
    } catch (err) {
      await session.hangup(`voice session failed to start: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
    return session;
  }

  get(callId: string) {
    return this.sessions.get(callId);
  }

  /** The SIP domain transferred legs arrive on (TELNYX_TAKEOVER_SIP_DOMAIN), if takeovers are set up. */
  get takeoverSipDomain(): string | undefined {
    return this.d.takeoverSipDomain;
  }

  /** Why no call can be taken over (telegram.yaml takeover off, no TELNYX_TAKEOVER_SIP_DOMAIN), or null. */
  takeoverOff(): string | null {
    if (!this.d.config().telegram.takeover.enabled) return "taking calls over is turned off (telegram.yaml takeover)";
    if (!this.d.takeoverSipDomain) return "taking calls over isn't set up (TELNYX_TAKEOVER_SIP_DOMAIN)";
    return null;
  }

  /** Why `callId` can't be taken over now (not live, not a phone call, already taken over, feature off), or null. */
  canTakeOver(callId: string): string | null {
    const off = this.takeoverOff();
    if (off) return off;
    const s = this.sessions.get(callId);
    if (!s) return this.pending.has(callId) || this.attaching.has(callId) ? "the call isn't connected yet" : "that call has ended";
    if (s.channel !== "phone") return "only phone calls can be taken over";
    // Already the owner's: their page (re)attaches, replacing a connection that may be dead.
    if (s.takenOver) return null;
    return s.takeoverBlocked();
  }

  /**
   * Starts the takeover (or re-attaches the owner within reconnect_grace_ms after ownerLeft).
   * Resolves once the takeover has started (the leg may still be connecting; the leg gets
   * notify({type:"connecting"}) then {type:"live"} when audio flows). Throws with a readable
   * message if it can't start (same reasons as canTakeOver).
   */
  async takeOver(callId: string, leg: OwnerAudioLeg): Promise<TakeoverHandle> {
    const why = this.canTakeOver(callId);
    if (why) throw new Error(why);
    const s = this.sessions.get(callId)!;
    if (s.takenOver) return s.reattachOwner(leg);
    const tk = this.d.config().telegram.takeover;
    // Valid from now until the transferred leg is due (plus the REFER request's own time).
    const ttl = tk.max_handover_wait_ms + tk.leg_timeout_ms + 30_000;
    const referTo = s.overVoice ? takeoverUri(this.takeoverTokens.create(callId, ttl), this.d.takeoverSipDomain!) : null;
    return s.takeOver(leg, referTo);
  }

  /**
   * The owner's page reconnects with its handle's reconnectToken (Telegram's initData may be
   * stale by now): it takes the call over from its old connection. Throws if the token isn't the
   * current one or the call has ended.
   */
  resumeTakeover(callId: string, reconnectToken: string, leg: OwnerAudioLeg): TakeoverHandle {
    const s = this.sessions.get(callId);
    if (!s?.reconnectTokenValid(reconnectToken)) throw new Error(s?.takenOver ? "that connection was replaced" : "that call has ended");
    return s.reattachOwner(leg);
  }

  /**
   * Telnyx offers a transferred leg that dialled `token`: the call it belongs to (whose hangups
   * now go to `callControlId`), or null if the token is unknown, expired or used, or that call
   * isn't waiting for one. Refuse the leg then.
   */
  claimTakeoverLeg(token: string, callControlId: string): string | null {
    const callId = this.takeoverTokens.claim(token);
    if (!callId) return null;
    return this.sessions.get(callId)?.takeoverLegOffered(callControlId) ? callId : null;
  }

  /** The transferred leg's media stream connected; throws if its call isn't waiting for it. */
  attachTakeoverLeg(callId: string, media: MediaChannel, codec: Codec): void {
    const s = this.sessions.get(callId);
    if (!s) throw new Error(`call ${callId} has ended`);
    s.attachTakeoverLeg(media, codec);
  }

  async hangup(callId: string, reason: string, by: EndedBy = "system") {
    this.pending.delete(callId);
    const s = this.sessions.get(callId);
    if (s) return s.stop(reason, by);
    const attaching = this.attaching.get(callId);
    if (attaching) {
      // Its session is on the way: stop it once it exists. A failed start has ended the call already.
      const started = await attaching.catch(() => null);
      return started?.stop(reason, by);
    }
    // Hung up before media connected (or after a restart): just close the record.
    const call = await this.d.repo.getCall(callId);
    if (call && call.status !== "ended") {
      this.d.bus.publish({
        type: "call.ended",
        callId,
        at: this.d.clock.now() - call.startedAt,
        endedAt: this.d.clock.now(),
        reason,
        endedBy: by,
        costUsd: 0,
        lunaCalls: 0,
        jevTicks: 0,
      });
    }
  }

  /**
   * Records the SIP headers a call arrived with and the carrier's other call metadata (the call
   * page's call info). Recorded even when there are none, so the page can say so.
   */
  async sipHeaders(callId: string, source: "openai" | "telnyx", headers: SipHeader[], extra: { mediaSecurity?: string; info?: Record<string, string> } = {}) {
    const at = await this.elapsed(callId);
    if (at === null) return;
    const { mediaSecurity, info } = extra;
    this.d.bus.publish({ type: "sip.headers", callId, at, source, headers, ...(mediaSecurity ? { mediaSecurity } : {}), ...(info ? { info } : {}) });
  }

  /** Records the carrier's account of the hangup; it often arrives after the call has ended here. */
  async carrierHangup(callId: string, info: Record<string, string>) {
    const at = await this.elapsed(callId);
    if (at !== null) this.d.bus.publish({ type: "carrier.hangup", callId, at, source: "telnyx", info });
  }

  /**
   * Adds the carrier's bill for the phone leg to the call's costs. It arrives after the hangup,
   * so it goes to the session's cost meter while the session is kept (KEEP_ENDED_MS), and onto
   * the stored costs after that (or after a restart), when persistence has long caught up.
   */
  async carrierCost(callId: string, usd: number) {
    this.pruneEnded();
    const session = this.sessions.get(callId) ?? this.ended.get(callId)?.session;
    if (session) return session.setCarrierCost(usd);
    const call = await this.d.repo.getCall(callId);
    if (!call?.costs) return; // never connected, or from before costs were recorded
    this.d.bus.publish({ type: "costs", callId, at: Math.max(0, this.d.clock.now() - call.startedAt), costs: withCarrier(call.costs, usd) });
  }

  private pruneEnded() {
    const now = this.d.clock.now();
    for (const [id, e] of this.ended) if (e.until !== null && e.until <= now) this.ended.delete(id);
  }

  /** ms since the call started, or null for an unknown call */
  private async elapsed(callId: string): Promise<number | null> {
    const call = await this.d.repo.getCall(callId);
    return call ? Math.max(0, this.d.clock.now() - call.startedAt) : null;
  }

  /** Records a note on a call, e.g. a telephony error outside the voice session. */
  async note(callId: string, level: "info" | "warn" | "error", message: string) {
    const call = await this.d.repo.getCall(callId);
    if (!call) return;
    this.d.bus.publish({ type: "note", callId, at: Math.max(0, this.d.clock.now() - call.startedAt), level, message });
  }

  /**
   * Ends calls that are still open in the DB but have no live session: media never connected
   * (e.g. a missed call.hangup webhook) or the server restarted mid-call. Only calls older than
   * `olderThanMs` are touched, so a call between answer and media connect is left alone.
   */
  async reapOrphans(olderThanMs: number, reason: string) {
    const now = this.d.clock.now();
    for (const call of await this.d.repo.listOpenCalls()) {
      if (this.sessions.has(call.id) || this.attaching.has(call.id) || now - call.startedAt < olderThanMs) continue;
      // The phone call may still be up at the carrier with nothing attached; hang it up too.
      await this.d.telephony.hangup(call.callControlId).catch(() => undefined);
      await this.hangup(call.id, reason);
    }
  }

  saveRecording(callId: string, data: ArrayBuffer, ext: "mp3" | "wav"): Promise<void> {
    return this.track(
      (async () => {
        const key = `recordings/${callId}.${ext}`;
        await this.d.blobs.put(key, data, ext === "mp3" ? "audio/mpeg" : "audio/wav");
        await this.recordingStored(callId, key);
      })(),
    );
  }

  /**
   * A recording of the call written while it runs (`recordings/<call id>.wav`): appends go to the
   * store in order, without blocking the caller; finish() stores it, publishes the `recording`
   * event and is waited for by stopAll. A failed write is logged and stops the recording (what
   * was written is still stored); it never fails the call.
   */
  openRecording(callId: string, rate: number, channels: number): RecordingWriter {
    const sink = this.recordings.open(`recordings/${callId}.wav`, { rate, channels });
    let chain = Promise.resolve();
    let failed = false;
    let finished: Promise<string | null> | undefined;
    return {
      append: (pcm) => {
        if (failed || finished) return;
        chain = chain
          .then(() => (failed ? undefined : sink.append(pcm)))
          .catch((err) => {
            if (failed) return;
            failed = true;
            recLog.warn("recording write failed: the rest of the call isn't recorded", { callId, err });
            void this.note(callId, "warn", "recording stopped: writing it failed").catch(() => undefined);
          });
      },
      finish: () =>
        (finished ??= this.track(
          chain
            .then(() => sink.finish())
            .then(async (path) => {
              await this.recordingStored(callId, path);
              return path;
            })
            .catch((err) => {
              recLog.warn("recording not saved", { callId, err });
              return null;
            }),
        )),
    };
  }

  /**
   * Stores the recordings a crash left unfinished (RecordingStore.recover), each as its call's
   * recording unless the call has one already.
   */
  async recoverRecordings() {
    for (const key of (await this.recordings.recover?.()) ?? []) {
      const callId = key.match(/^recordings\/(.+?)(?:\.recovered)?\.wav$/)?.[1];
      const call = callId ? await this.d.repo.getCall(callId) : null;
      if (call && !call.recordingPath) {
        await this.recordingStored(call.id, key);
        recLog.info("recovered the recording of an interrupted call", { callId: call.id, path: key });
      } else recLog.info(`recovered an interrupted recording: ${key} (${call ? "the call has another recording" : "no such call"})`, { callId: call?.id });
    }
  }

  private async recordingStored(callId: string, path: string) {
    const call = await this.d.repo.getCall(callId);
    this.d.bus.publish({ type: "recording", callId, at: call ? this.d.clock.now() - call.startedAt : 0, path });
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    const done = () => void this.background.delete(p);
    p.then(done, done);
    return p;
  }

  /**
   * Hangs up every live call and waits for all wrap-ups, including calls that ended just before
   * (Luna draining, summaries) and the recordings their voice sessions hand over as they close.
   */
  async stopAll(reason: string) {
    this.shuttingDown = true;
    // Includes sessions still connecting: hanging up aborts the connect.
    await Promise.all([...this.sessions.values()].map((s) => s.hangup(reason)));
    await Promise.allSettled([...this.attaching.values()]);
    while (this.background.size) await Promise.allSettled([...this.background]);
  }
}
