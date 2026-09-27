import type { GamesConfig } from "./config";
import type { CallEvent } from "./types";

// The public page's games (config/games.yaml): what a call means for the player. Pure.
//   scam         the player is the scammer: 10 points a second from the scam's start (the
//                referee says they've claimed to be who the goal says) until the call ends,
//                scam.undetected_multiplier times that before they're caught; most wins
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
  /** As the referee judged it, from the caller's line that did it. Scam: the start, from the
   * line's start; get through: the message passed on, at the line's end */
  goalAt: number | null;
}

export const START: PlayState = { verdict: null, lean: 0, stage: null, caughtAt: null, goalAt: null };

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

/** Each game's referee question (games.yaml referee): its "yes" sets PlayState.goalAt. */
export const REFEREE_QUESTION = { scam: "start", get_through: "message" } as const satisfies Record<Game, string>;

/** The referee says the game's question was met in the caller's `line` (only the first time counts). */
export function goalMet(prev: PlayState, game: Game, line: { at: number; endAt: number }): PlayState {
  if (prev.goalAt !== null) return prev;
  return { ...prev, goalAt: game === "scam" ? line.at : line.endAt };
}

/** A scam point is a tenth of a second (a score of 18.1 s is 181 points). */
export const POINT_MS = 100;

/**
 * Scam: the whole points (tenths of a second) from the start until `endAt`, split at the catch.
 * The page shows the same split (src/web/client/public.ts), so its points add up to the score.
 */
export function scamTicks(s: PlayState, endAt: number): { undetected: number; caught: number } {
  if (s.goalAt === null) return { undetected: 0, caught: 0 };
  const undetectedMs = Math.max(0, Math.min(s.caughtAt ?? endAt, endAt) - s.goalAt);
  const caughtMs = Math.max(0, endAt - s.goalAt - undetectedMs);
  return { undetected: Math.floor(undetectedMs / POINT_MS), caught: Math.floor(caughtMs / POINT_MS) };
}

/**
 * The player's score in ms, or null if they didn't make it.
 * Scam: points (POINT_MS each) from the start until the call ended (`endAt`), the ones before
 * being caught counted `undetectedMultiplier` times.
 * Get through: until the message was passed on, unless caught before it.
 */
export function scoreOf(game: Game, s: PlayState, endAt: number | null, undetectedMultiplier: number): number | null {
  if (s.goalAt === null) return null;
  if (game === "get_through") return s.caughtAt !== null && s.caughtAt < s.goalAt ? null : s.goalAt;
  if (endAt === null) return null;
  const t = scamTicks(s, endAt);
  return Math.round(undetectedMultiplier * t.undetected + t.caught) * POINT_MS;
}

/**
 * For the call's log: the game's times and its score, or why it has none, e.g.
 * "start 30.1s · caught 38.5s · ended 120.0s → score 984 points".
 */
export function playSummary(game: Game, s: PlayState, endAt: number | null, undetectedMultiplier: number): string {
  const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const times = game === "scam"
    ? `start ${secs(s.goalAt)} · caught ${secs(s.caughtAt)} · ended ${secs(endAt)}`
    : `message ${secs(s.goalAt)} · caught ${secs(s.caughtAt)}`;
  const score = scoreOf(game, s, endAt, undetectedMultiplier);
  if (score !== null) return `${times} → score ${game === "scam" ? `${score / POINT_MS} points` : secs(score)}`;
  const why =
    s.goalAt === null ? (game === "scam" ? "never started the scam" : "message not passed on")
    : game === "scam" ? "call still going"
    : "caught before the message";
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
