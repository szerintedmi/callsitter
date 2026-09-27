import type { GamesConfig } from "./config";
import type { CallEvent } from "./types";

// The public page's games (config/games.yaml): what a call means for the player. Pure.
//   scam         the player is the scammer: scored from their move (the referee says they've taken
//                on the goal's role) until caught, longest wins, if they asked for what the goal
//                wants before being caught
//   get_through  the player is a real caller: scored by how long until the referee says they
//                passed on their message, unless caught first; fastest wins

export const GAMES = ["scam", "get_through"] as const;
export type Game = (typeof GAMES)[number];

/** What the page shows during a call, and what the score is made from. Times: ms since call start. */
export interface PlayState {
  /** Jev's verdict, null while unclear (the page doesn't show it) */
  verdict: string | null;
  /** -1 (genuine) .. 1 (scam or spam): P(scam) + P(spam) - P(genuine); unclear pulls it to 0 */
  lean: number;
  /** the call-flow stage */
  stage: string | null;
  /** when the call first entered one of games.yaml scam.caught_stages */
  caughtAt: number | null;
  /** scam: the move (taking on the role); get through: the message passed on. As the referee
   * judged it: the end of the caller's turn that did it */
  goalAt: number | null;
  /** scam: when the caller asked for what the goal wants: the start of the turn that did it, so
   * being caught mid-ask still counts the ask */
  askedAt: number | null;
}

export const START: PlayState = { verdict: null, lean: 0, stage: null, caughtAt: null, goalAt: null, askedAt: null };

/** The state after `ev`, or null if `ev` doesn't change it. */
export function nextPlay(prev: PlayState, ev: CallEvent, games: GamesConfig): PlayState | null {
  if (ev.type === "classification") {
    const c = ev.classification;
    const p = c.answers.verdict?.probabilities;
    const verdict = c.answers.verdict?.choice ?? c.verdict;
    const lean = p
      ? (p.scam ?? 0) + (p.spam ?? 0) - (p.genuine ?? 0)
      : verdict === "genuine" ? -c.confidence : verdict === "unclear" ? 0 : c.confidence;
    return { ...prev, verdict: verdict === "unclear" ? null : verdict, lean: Math.max(-1, Math.min(1, lean)) };
  }
  if (ev.type !== "stage") return null;
  const next = { ...prev, stage: ev.stage };
  if (games.scam.caught_stages.includes(ev.stage)) next.caughtAt ??= ev.at;
  return next;
}

/** The referee's questions (games.yaml referee), and which PlayState time each one sets. */
export const REFEREE_QUESTIONS = { scam: ["move", "ask"], get_through: ["message"] } as const satisfies Record<Game, readonly string[]>;
const SETS: Record<string, "goalAt" | "askedAt"> = { move: "goalAt", message: "goalAt", ask: "askedAt" };

/** The referee says `question` was met in the caller's `turn` (only the first time counts). */
export function goalMet(prev: PlayState, question: string, turn: { at: number; endAt: number }): PlayState {
  const key = SETS[question];
  if (!key || prev[key] !== null) return prev;
  return { ...prev, [key]: key === "askedAt" ? turn.at : turn.endAt };
}

/**
 * The player's score in ms, or null if they didn't make it.
 * Scam: from the move until caught, or until the call ended (`endAt`) if never caught; only if
 * they asked for what the goal wants before being caught.
 * Get through: until the message was passed on, unless caught before it.
 */
export function scoreOf(game: Game, s: PlayState, endAt: number | null = null): number | null {
  if (s.goalAt === null) return null;
  if (s.caughtAt !== null && s.caughtAt < s.goalAt) return null;
  if (game === "get_through") return s.goalAt;
  if (s.askedAt === null || (s.caughtAt !== null && s.caughtAt < s.askedAt)) return null;
  if (s.caughtAt !== null) return s.caughtAt - s.goalAt;
  return endAt === null ? null : Math.max(0, endAt - s.goalAt);
}

/**
 * For the call's log: the game's times and its score, or why it has none, e.g.
 * "move 10.7s · ask 62.9s · caught 68.9s → score 58.2s".
 */
export function playSummary(game: Game, s: PlayState, endAt: number | null = null): string {
  const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const times = game === "scam"
    ? `move ${secs(s.goalAt)} · ask ${secs(s.askedAt)} · caught ${secs(s.caughtAt)}`
    : `message ${secs(s.goalAt)} · caught ${secs(s.caughtAt)}`;
  const score = scoreOf(game, s, endAt);
  if (score !== null) return `${times} → score ${secs(score)}`;
  const caughtBefore = (at: number) => s.caughtAt !== null && s.caughtAt < at;
  const why =
    s.goalAt === null ? (game === "scam" ? "no move" : "message not passed on")
    : caughtBefore(s.goalAt) ? `caught before the ${game === "scam" ? "move" : "message"}`
    : s.askedAt === null ? "never asked"
    : caughtBefore(s.askedAt) ? "asked after caught"
    : "call still going";
  return `${times} → no score (${why})`;
}

/** Whether score `a` beats `b`. */
export function beats(game: Game, a: number, b: number): boolean {
  return game === "scam" ? a > b : a < b;
}

export interface BoardEntry {
  player: string;
  scoreMs: number;
}

/** 1 + the scores (the player's own too) that beat `scoreMs`. */
export function rankIn(game: Game, entries: readonly BoardEntry[], scoreMs: number): number {
  return entries.filter((e) => beats(game, e.scoreMs, scoreMs)).length + 1;
}

/** A player name as stored: 1–3 capital letters or digits, or null if it isn't one. */
export function playerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toUpperCase();
  return /^[A-Z0-9]{1,3}$/.test(name) ? name : null;
}
