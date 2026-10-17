import { b64decode, b64encode, fromPcm16, Resampler, SAMPLE_RATE, toPcm16, type Codec } from "./audio";
import type { CallRecording, Clock, OwnerPageStats } from "./ports";

// The owner takes a call over (telegram.yaml takeover). Over OpenAI SIP the call leaves OpenAI by
// a REFER to the Call Control app's SIP subdomain (TELNYX_TAKEOVER_SIP_DOMAIN), dialling a
// one-time token, so the Telnyx webhook can tell the transferred leg from a new call; over the
// media stream it stays on its leg. Either way the caller's audio then goes to the owner's page
// and the owner's back to the caller (OwnerBridge).

/** The user part the transferred leg dials: `cstakeover<token>@<domain>`. */
export const TAKEOVER_USER_PREFIX = "cstakeover";

export const takeoverUri = (token: string, domain: string) => `sip:${TAKEOVER_USER_PREFIX}${token}@${domain}`;

/**
 * A call's `to` (or to_sip_uri) on the takeover domain: the token it dialled, or "" if it has
 * none (to be refused). null: not on that domain, an ordinary call.
 */
export function takeoverTokenFrom(to: string | undefined, domain: string): string | null {
  const m = to?.match(/^(?:sips?:)?([^@;>]*)@([^;>:]+)/i);
  if (!m || m[2]!.toLowerCase() !== domain.toLowerCase()) return null;
  return m[1]!.match(new RegExp(`^${TAKEOVER_USER_PREFIX}([0-9a-f]{32})$`))?.[1] ?? "";
}

/** One-time tokens for transferred legs, each bound to a call and valid for `ttlMs`. */
export class TakeoverTokens {
  private tokens = new Map<string, { callId: string; expires: number }>();

  constructor(private clock: Clock) {}

  create(callId: string, ttlMs: number): string {
    this.sweep();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.tokens.set(token, { callId, expires: this.clock.now() + ttlMs });
    return token;
  }

  /** The token's call, once: null if unknown, expired or used. */
  claim(token: string): string | null {
    this.sweep();
    const t = this.tokens.get(token);
    if (!t) return null;
    this.tokens.delete(token);
    return t.callId;
  }

  revoke(callId: string) {
    for (const [k, v] of this.tokens) if (v.callId === callId) this.tokens.delete(k);
  }

  private sweep() {
    const now = this.clock.now();
    for (const [k, v] of this.tokens) if (v.expires <= now) this.tokens.delete(k);
  }
}

/** The owner's page's audio: 16 kHz mono PCM16. */
export const OWNER_RATE = 16_000;

/** a pause this long between the owner's 20 ms frames counts as a gap (late or lost audio) */
export const OWNER_GAP_MS = 100;

/** Frames, length and level of one direction's audio. */
class Flow {
  frames = 0;
  samples = 0;
  peak = 0;
  private sumSq = 0;

  add(pcm: Int16Array) {
    this.frames++;
    this.samples += pcm.length;
    for (const v of pcm) {
      const a = Math.abs(v);
      if (a > this.peak) this.peak = a;
      this.sumSq += v * v;
    }
  }

  fields(rate: number) {
    const rms = this.samples ? Math.sqrt(this.sumSq / this.samples) : 0;
    return { frames: this.frames, seconds: round1(this.samples / rate), peakDbfs: dbfs(this.peak), rmsDbfs: dbfs(rms) };
  }
}

/** dBFS of a PCM16 amplitude, floored at -96 (digital silence) */
const dbfs = (amp: number) => Math.max(-96, Math.round(20 * Math.log10(Math.max(amp, 1e-9) / 32768))) + 0; // + 0: no -0
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Converts audio between the phone leg (`codec`, base64 as the media channel carries it) and the
 * owner's page, and copies both sides to the recording (OpenAI SIP: the sideband's, kept going).
 */
export class OwnerBridge {
  private toOwner: Resampler;
  private toCaller: Resampler;
  private callerFlow = new Flow();
  private ownerFlow = new Flow();
  private startedAt: number;
  /** when the owner's last frame arrived; 0 after a reconnect, so the time away isn't a gap */
  private ownerFrameAt = 0;
  private gaps = 0;
  private longestGap = 0;

  constructor(
    private codec: Codec,
    private recording: CallRecording | null,
    private clock: Clock,
  ) {
    this.startedAt = clock.now();
    this.toOwner = new Resampler(SAMPLE_RATE[codec], OWNER_RATE);
    this.toCaller = new Resampler(OWNER_RATE, SAMPLE_RATE[codec]);
  }

  /** Caller audio from the media leg → the owner's page. */
  callerAudio(b64: string): Int16Array {
    const pcm = toPcm16(b64decode(b64), this.codec);
    this.callerFlow.add(pcm);
    this.recording?.caller(pcm, SAMPLE_RATE[this.codec]);
    return this.toOwner.push(pcm);
  }

  /** The owner's mic → base64 audio for the media leg. */
  ownerAudio(pcm16: Int16Array): string {
    const now = this.clock.now();
    if (this.ownerFrameAt && now - this.ownerFrameAt > OWNER_GAP_MS) {
      this.gaps++;
      this.longestGap = Math.max(this.longestGap, now - this.ownerFrameAt);
    }
    this.ownerFrameAt = now;
    this.ownerFlow.add(pcm16);
    this.recording?.owner(pcm16, OWNER_RATE);
    return b64encode(fromPcm16(this.toCaller.push(pcm16), this.codec));
  }

  /** A new page connection took over: its first frame after the time away isn't a gap. */
  ownerReconnected() {
    this.ownerFrameAt = 0;
  }

  /**
   * The takeover's audio, for its log line and the timeline: each direction's length and level
   * (a dead mic shows as about -96 dBFS; mutedMs says how much of that was the mute button), the
   * owner's frame gaps (jitter or loss on the way in), and `pages`' counters (each page
   * connection's latest), summed.
   */
  summary(reconnects: number, pages: OwnerPageStats[]): { text: string; fields: Record<string, unknown> } {
    const page = { sentFrames: 0, underruns: 0, mutedMs: 0, connections: pages.length };
    for (const p of pages) {
      page.sentFrames += p.sentFrames;
      page.underruns += p.underruns;
      page.mutedMs += p.mutedMs;
    }
    const toOwner = this.callerFlow.fields(SAMPLE_RATE[this.codec]);
    const toCaller = this.ownerFlow.fields(OWNER_RATE);
    const liveSeconds = round1((this.clock.now() - this.startedAt) / 1000);
    const gaps = { count: this.gaps, longestMs: this.longestGap };
    const text =
      `takeover audio: ${liveSeconds} s live, ${reconnects} reconnect${reconnects === 1 ? "" : "s"}; ` +
      `caller→owner ${toOwner.seconds} s (peak ${toOwner.peakDbfs} dBFS, rms ${toOwner.rmsDbfs}); ` +
      `owner→caller ${toCaller.seconds} s (peak ${toCaller.peakDbfs} dBFS, rms ${toCaller.rmsDbfs}), ` +
      `${gaps.count} gap${gaps.count === 1 ? "" : "s"} > ${OWNER_GAP_MS} ms${gaps.count ? `, longest ${gaps.longestMs} ms` : ""}` +
      (page.connections
        ? `; page: ${page.underruns} underrun${page.underruns === 1 ? "" : "s"}, muted ${round1(page.mutedMs / 1000)} s, ${page.sentFrames} frames sent`
        : "; no page stats");
    return { text, fields: { liveSeconds, reconnects, toOwner, toCaller, ownerGaps: gaps, page } };
  }
}
