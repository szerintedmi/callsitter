import type { Speaker, TranscriptEntry } from "./types";

/**
 * Transcript assembled from streaming deltas. Each vendor item id is one utterance.
 * Entries get a seq when first seen, so ordering follows who started speaking first.
 */
export class TranscriptBuffer {
  private entries: TranscriptEntry[] = [];
  private byItem = new Map<string, TranscriptEntry>();
  private nextSeq = 1;
  /** bumps on every change */
  version = 0;
  /** bumps whenever the caller's words change, including new words within an utterance */
  callerRev = 0;
  /** a reply delay measured before the agent's utterance showed up: for its next one */
  private pendingReplyMs: number | undefined;

  constructor(private now: () => number) {}

  delta(speaker: Speaker, itemId: string, delta: string): TranscriptEntry {
    const e = this.entry(speaker, itemId);
    e.text += delta;
    this.version++;
    if (speaker === "caller" && delta.trim()) {
      this.callerRev++;
      this.pendingReplyMs = undefined;
    }
    return { ...e };
  }

  done(speaker: Speaker, itemId: string, text?: string): TranscriptEntry {
    const e = this.entry(speaker, itemId);
    const before = e.text.trim();
    if (text !== undefined && text.trim()) e.text = text;
    e.text = e.text.trim();
    if (speaker === "caller" && e.text !== before) this.callerRev++;
    e.final = true;
    e.endAt ??= this.now();
    this.version++;
    return { ...e };
  }

  /**
   * The agent's first audio since the caller spoke came `ms` after their last words: put it on
   * the agent utterance that started since then, or the next one. Returns the entry it changed.
   */
  replied(ms: number): TranscriptEntry | null {
    const last = this.entries.findLast((e) => e.speaker === "agent");
    if (last && last.replyMs === undefined && last.at >= this.now() - ms) {
      last.replyMs = ms;
      return { ...last };
    }
    this.pendingReplyMs = ms;
    return null;
  }

  all(): readonly TranscriptEntry[] {
    return this.entries.filter((e) => e.text.trim().length > 0);
  }

  /** highest seq so far */
  get seq(): number {
    return this.nextSeq - 1;
  }

  chars(speaker?: Speaker): number {
    return this.entries.reduce((n, e) => (speaker && e.speaker !== speaker ? n : n + e.text.length), 0);
  }

  private entry(speaker: Speaker, itemId: string): TranscriptEntry {
    let e = this.byItem.get(itemId);
    if (!e) {
      e = { seq: this.nextSeq++, speaker, text: "", at: this.now(), final: false, itemId };
      if (speaker === "agent" && this.pendingReplyMs !== undefined) {
        e.replyMs = this.pendingReplyMs;
        this.pendingReplyMs = undefined;
      }
      this.byItem.set(itemId, e);
      this.entries.push(e);
    }
    return e;
  }
}
