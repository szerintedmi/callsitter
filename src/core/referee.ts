import { REFEREE_QUESTION, type Game } from "./game";
import type { Referee, RefereeInput } from "./ports";
import type { TranscriptEntry } from "./types";

// The referee of one public game call (games.yaml referee): a separate Jev call that asks the
// game's question (scam: start; get through: message). The call's own Jev, Live and Luna never
// see the goal. It judges final transcripts only, so it runs as each caller line's final
// transcript arrives (Jev's pauses come before it, mid-turn too) until the question is met, and
// once more when the call ends, so the last words still count.

export interface GoalWatchDeps {
  referee: Referee;
  game: Game;
  goal: RefereeInput["goal"];
  config: () => RefereeInput["config"];
  /** the game's question was met in the caller's `line` that did it (ms since call start) */
  onMet(line: { at: number; endAt: number }): void;
  /** every judgement, for the call's log */
  onJudged(answers: Record<string, number>): void;
  onError(err: unknown): void;
}

export class GoalWatch {
  /** final utterances by seq */
  private entries = new Map<number, TranscriptEntry>();
  /** a judging loop is going; set before its first await */
  private busy = false;
  private loop: Promise<void> = Promise.resolve();
  /** caller words arrived during a judgement: judge again after it */
  private again = false;
  private stopped = false;
  private done = false;

  constructor(private d: GoalWatchDeps) {}

  add(entry: TranscriptEntry) {
    if (entry.final && entry.text) this.entries.set(entry.seq, entry);
  }

  /** A caller line is final: judge the transcript so far, unless the question is met. */
  check() {
    if (this.done || this.stopped) return;
    if (this.busy) this.again = true;
    else this.start();
  }

  /** The call has ended: one last judgement if the question is still open. */
  async final(): Promise<void> {
    await this.loop;
    if (!this.done && !this.stopped) await this.start();
    this.stopped = true;
  }

  /** Judges until no pause came in meanwhile. */
  private start(): Promise<void> {
    this.busy = true;
    this.loop = (async () => {
      try {
        do {
          this.again = false;
          await this.judge();
        } while (this.again && !this.done && !this.stopped);
      } finally {
        this.busy = false;
      }
    })();
    return this.loop;
  }

  private async judge(): Promise<void> {
    const transcript = [...this.entries.values()].sort((a, b) => a.seq - b.seq);
    const line = transcript.findLast((e) => e.speaker === "caller");
    if (!line) return;
    const cfg = this.d.config();
    try {
      const answers = await this.d.referee.judge({ game: this.d.game, goal: this.d.goal, transcript, config: cfg });
      this.d.onJudged(answers);
      if (this.done || (answers[REFEREE_QUESTION[this.d.game]] ?? 0) < cfg.min) return;
      this.done = true;
      this.d.onMet({ at: line.at, endAt: line.endAt ?? line.at });
    } catch (err) {
      this.d.onError(err);
    }
  }
}
