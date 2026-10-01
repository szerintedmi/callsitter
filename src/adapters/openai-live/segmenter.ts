import type { Speaker } from "../../core/types";

// Live transcript deltas carry only start_ms/end_ms: no item ids and no done events
// ("these events do not define complete turns or include a transcript-done event",
// openai/resources/live/live.d.ts). This groups deltas into utterances per speaker.
// Non-speech tags ("[chuckle]", "[tongue click]") are dropped: they came split over deltas
// ("[ch", "uckle]"), and each piece cut the other side's utterance in two.

export interface SegmenterSink {
  delta(speaker: Speaker, itemId: string, delta: string): void;
  done(speaker: Speaker, itemId: string): void;
}

interface Open {
  id: string;
  lastEndMs: number;
  lastSeenAt: number;
}

export class TranscriptSegmenter {
  private open = new Map<Speaker, Open>();
  /** inside a "[…]" tag, and where the speaker's last delta ended (Live timeline) */
  private tag = new Map<Speaker, { open: boolean; endMs: number }>();
  private n = 0;

  constructor(
    private sink: SegmenterSink,
    /** a gap on the Live timeline longer than this starts a new utterance */
    private gapMs = 900,
    /** close an utterance after this long without deltas (wall clock) */
    private idleMs = 1500,
    private now: () => number = Date.now,
  ) {}

  push(speaker: Speaker, delta: string, startMs: number, endMs: number) {
    delta = this.dropTags(speaker, delta, startMs, endMs);
    let cur = this.open.get(speaker);
    // Nothing said: no new utterance for a lone "." or "?" either.
    if (!delta.trim() || (!cur && !/[\p{L}\p{N}]/u.test(delta))) return;
    const other: Speaker = speaker === "caller" ? "agent" : "caller";
    if (cur && startMs - cur.lastEndMs > this.gapMs) {
      this.close(speaker);
      cur = undefined;
    }
    if (!cur) {
      // A new utterance from one side ends the other side's utterance.
      this.close(other);
      cur = { id: `${speaker}-${++this.n}`, lastEndMs: endMs, lastSeenAt: this.now() };
      this.open.set(speaker, cur);
    }
    cur.lastEndMs = Math.max(cur.lastEndMs, endMs);
    cur.lastSeenAt = this.now();
    this.sink.delta(speaker, cur.id, delta);
  }

  /** The delta without "[…]" tags, which can span deltas (an unclosed one ends at a gap). */
  private dropTags(speaker: Speaker, delta: string, startMs: number, endMs: number): string {
    const t = this.tag.get(speaker);
    let inTag = !!t?.open && startMs - t.endMs <= this.gapMs;
    let out = "";
    for (const ch of delta) {
      if (ch === "[") inTag = true;
      else if (ch === "]") inTag = false;
      else if (!inTag) out += ch;
    }
    this.tag.set(speaker, { open: inTag, endMs });
    return out;
  }

  /** Call periodically; closes utterances idle for longer than idleMs. */
  sweep() {
    const now = this.now();
    for (const [speaker, cur] of this.open) {
      if (now - cur.lastSeenAt > this.idleMs) this.close(speaker);
    }
  }

  flush() {
    for (const speaker of [...this.open.keys()]) this.close(speaker);
  }

  private close(speaker: Speaker) {
    const cur = this.open.get(speaker);
    if (!cur) return;
    this.open.delete(speaker);
    this.sink.done(speaker, cur.id);
  }
}
