import type { AudioFormat } from "./audio";
import { CallSession, type CallSessionDeps } from "./call-session";
import { withCarrier } from "./cost";
import type { BlobStore, EventBus, MediaChannel, Repo, VoiceAgent } from "./ports";
import type { CallMeta, EndedBy, SipHeader } from "./types";

// Registry of live calls plus the call lifecycle (incoming → media → hangup → recording).

export type SharedDeps = Omit<CallSessionDeps, "meta" | "callControlId" | "media" | "mediaViaVoice" | "onStopped" | "dryRun"> & {
  repo: Repo;
  blobs: BlobStore;
};

export interface AttachOptions {
  dryRun?: boolean;
  /** per-call voice agent (OpenAI SIP: accept + sideband for this session) instead of the shared one */
  voice?: VoiceAgent;
  mediaViaVoice?: boolean;
  /** caps flow.timing.max_call_seconds for this call (public calls) */
  maxCallSeconds?: number;
}

/**
 * How long an ended call's session stays reachable for the carrier's bill (Telnyx call.cost,
 * seconds after the hangup). The session's cost meter is the truth until then: the stored costs
 * can lag behind persistence.
 */
const KEEP_ENDED_MS = 10 * 60_000;

/** For calls whose audio doesn't pass through us (OpenAI SIP): agent audio copies are dropped. */
export const NO_MEDIA: MediaChannel = { sendAudio() {}, clear() {}, close() {} };

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

  constructor(private d: SharedDeps) {}

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

  async registerIncoming(c: { callId: string; callControlId: string; from: string; to: string; divertedFrom?: string; callerIp?: string }) {
    // Checked before the first await, so a call can't slip in after a drain reports no calls.
    if (!this.accepting) throw new Error("not accepting calls (draining or shutting down)");
    this.pending.add(c.callId);
    const startedAt = this.d.clock.now();
    try {
      await this.d.repo.createCall({
        id: c.callId,
        callControlId: c.callControlId,
        from: c.from,
        to: c.to,
        divertedFrom: c.divertedFrom ?? null,
        callerIp: c.callerIp ?? null,
        startedAt,
      });
    } catch (err) {
      this.pending.delete(c.callId);
      throw err;
    }
    const meta: CallMeta = { callId: c.callId, from: c.from, to: c.to, divertedFrom: c.divertedFrom, startedAt };
    this.d.bus.publish({ type: "call.started", callId: c.callId, meta });
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

    const cap = opts.maxCallSeconds;
    const config = cap
      ? () => {
          const cfg = this.d.config();
          const timing = { ...cfg.flow.timing, max_call_seconds: Math.min(cfg.flow.timing.max_call_seconds, cap) };
          return { ...cfg, flow: { ...cfg.flow, timing } };
        }
      : this.d.config;
    const session = new CallSession({
      ...this.d,
      config,
      meta: {
        callId,
        from: call.from,
        to: call.to,
        divertedFrom: call.divertedFrom ?? undefined,
        startedAt: call.startedAt,
      },
      callControlId: call.callControlId,
      media,
      voice: opts.voice ?? this.d.voice,
      mediaViaVoice: opts.mediaViaVoice,
      dryRun: opts.dryRun,
      onStopped: () => {
        if (this.sessions.get(callId) === session) this.sessions.delete(callId);
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
        const call = await this.d.repo.getCall(callId);
        this.d.bus.publish({ type: "recording", callId, at: call ? this.d.clock.now() - call.startedAt : 0, path: key });
      })(),
    );
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
