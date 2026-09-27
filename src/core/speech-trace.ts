import { logger } from "./log";

const log = logger("speech");

/** Speech frames closer together than this are one segment. */
const SEGMENT_JOIN_MS = 500;
/** A pause in the reflected caller audio at least this long is logged. */
const GAP_MS = 200;

type Side = "caller" | "agent";

/**
 * What the silence watchdog heard on an OpenAI SIP call, for checking it against a recording:
 * each side's speech segments, and gaps in the caller audio the sideband reflects (the watchdog
 * can't hear speech in a gap). Written to the call's log file; `summary()` is for the timeline.
 * Times are ms since the call started.
 */
export class SpeechTrace {
  private segments: Record<Side, { start: number; end: number; peak: number } | null> = { caller: null, agent: null };
  private firstFrameAt = -1;
  /** when the caller audio received so far ends, if it streamed in real time */
  private streamedUntil = 0;
  private receivedMs = 0;
  private gaps = 0;
  private longestGap = 0;

  constructor(private callId: string) {}

  /** A reflected caller frame of `ms` arrived at `at`. */
  callerAudio(at: number, ms: number) {
    if (this.firstFrameAt < 0) this.firstFrameAt = at;
    else {
      const gap = at - this.streamedUntil;
      if (gap >= GAP_MS) {
        this.gaps++;
        this.longestGap = Math.max(this.longestGap, gap);
        log.info(`sideband caller audio gap: ${gap} ms at ${fmt(this.streamedUntil)}`, { callId: this.callId, gapMs: gap, at: this.streamedUntil });
      }
    }
    this.receivedMs += ms;
    this.streamedUntil = Math.max(at, this.streamedUntil) + ms;
  }

  /** A frame of `ms` at `dbfs` that the watchdog counted as speech. */
  speech(side: Side, at: number, ms: number, dbfs: number) {
    const s = this.segments[side];
    if (s && at - s.end <= SEGMENT_JOIN_MS) {
      s.end = Math.max(s.end, at + ms);
      s.peak = Math.max(s.peak, dbfs);
      return;
    }
    this.flush(side);
    this.segments[side] = { start: at, end: at + ms, peak: dbfs };
  }

  /** Logs the open segments; the one-line audio summary, or null if no caller audio came. */
  summary(): string | null {
    this.flush("caller");
    this.flush("agent");
    if (this.firstFrameAt < 0) return null;
    const span = this.streamedUntil - this.firstFrameAt;
    return (
      `sideband caller audio: ${(this.receivedMs / 1000).toFixed(1)} s received over ${(span / 1000).toFixed(1)} s, ` +
      `${this.gaps} gap${this.gaps === 1 ? "" : "s"} ≥ ${GAP_MS} ms${this.gaps ? `, longest ${this.longestGap} ms` : ""}`
    );
  }

  private flush(side: Side) {
    const s = this.segments[side];
    if (!s) return;
    this.segments[side] = null;
    log.info(`${side} speech ${fmt(s.start)}–${fmt(s.end)} (peak ${s.peak.toFixed(0)} dBFS)`, {
      callId: this.callId,
      side,
      startMs: s.start,
      endMs: s.end,
    });
  }
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
