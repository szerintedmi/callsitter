import { expect, test } from "bun:test";
import { buildRefereeRequest } from "../src/adapters/jev/referee";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { ConfigError, checkGames } from "../src/core/config";
import { START, goalMet, nextPlay, playSummary, playerName, rankIn, scoreOf, type PlayState } from "../src/core/game";
import { GoalWatch } from "../src/core/referee";
import type { TranscriptEntry } from "../src/core/types";
import type { CallEvent } from "../src/core/types";
import { cls, loadRepoConfig } from "./helpers";

// The public page's games (src/core/game.ts): scoring from a call's events, and leaderboards.

const cfg = await loadRepoConfig();
const games = cfg.games;
const classification = (verdict: "scam" | "genuine" | "unclear", confidence = 0.9): CallEvent =>
  ({ type: "classification", callId: "c", at: 0, classification: cls({ verdict, confidence }) });
const stage = (s: string, at: number): CallEvent => ({ type: "stage", callId: "c", at, stage: s });
const run = (...events: CallEvent[]) => events.reduce<PlayState>((s, ev) => nextPlay(s, ev, games) ?? s, START);

/** a caller line ending at `endAt` */
const line = (endAt: number, at = endAt - 1000) => ({ at, endAt });
const x = games.scam.undetected_multiplier;
const caught = (s: PlayState, at: number) => nextPlay(s, stage(games.scam.caught_stages[0]!, at), games)!;

test("scam me scores 10 points a second from the start until the call ends, more while undetected", () => {
  expect(x).toBe(2);
  const started = goalMet(START, "scam", line(21_000, 20_000)); // from the line's start
  expect(started.goalAt).toBe(20_000);
  // Never caught: 60 s from the start, all double: 1200 points (100 ms each).
  expect(scoreOf("scam", started, 80_000, x)).toBe(120_000);
  // Caught 10 s after the start, then kept talking: 10 s double, 50 s single.
  expect(scoreOf("scam", caught(started, 30_000), 80_000, x)).toBe(70_000);
  // Caught before the start: it still scores, all single.
  expect(scoreOf("scam", goalMet(caught(START, 10_000), "scam", line(21_000, 20_000)), 80_000, x)).toBe(60_000);
  // Only the first catch counts, even after the call recovers.
  const recovered = run(stage(games.scam.caught_stages[0]!, 8000), classification("genuine"), stage(games.scam.caught_stages[0]!, 12_000));
  expect(recovered.caughtAt).toBe(8000);
  // Whole points (tenths of a second) on each side of the catch: 8.45 s undetected, 81.5 s after.
  expect(scoreOf("scam", caught(goalMet(START, "scam", line(31_000, 30_050)), 38_500), 120_000, x)).toBe(98_300);
  // Only the first start counts.
  expect(goalMet(started, "scam", line(40_000)).goalAt).toBe(20_000);
});

test("scam me without the start scores nothing, however long the chat", () => {
  expect(scoreOf("scam", START, 600_000, x)).toBeNull();
  expect(scoreOf("scam", caught(START, 30_000), 600_000, x)).toBeNull();
  // Still going: no score yet.
  expect(scoreOf("scam", goalMet(START, "scam", line(5000)), null, x)).toBeNull();
});

test("get through scores when the message was passed on (the line's end), unless caught first", () => {
  expect(scoreOf("get_through", goalMet(START, "get_through", line(20_000)), null, x)).toBe(20_000);
  expect(scoreOf("get_through", goalMet(run(stage(games.scam.caught_stages[0]!, 10_000)), "get_through", line(20_000)), null, x)).toBeNull();
  expect(scoreOf("get_through", START, 60_000, x)).toBeNull();
});

test("the referee judges each caller line until the question is met, then once more when the call ends", async () => {
  const judged: number[] = [];
  let answers: Record<string, number> = { start: 0.1 };
  const met: { at: number; endAt: number }[] = [];
  const logged: Record<string, number>[] = [];
  const w = new GoalWatch({
    referee: { judge: async (i) => (judged.push(i.transcript.length), answers) },
    game: "scam",
    goal: games.scam.goals[0]!,
    config: () => games.referee,
    onMet: (l) => met.push(l),
    onJudged: (a) => logged.push(a),
    onError: (err) => { throw err; },
  });
  const say = (seq: number, at: number): TranscriptEntry => ({ seq, speaker: "caller", text: `line ${seq}`, at, endAt: at + 500, final: true });
  const reply = (seq: number, at: number): TranscriptEntry => ({ seq, speaker: "agent", text: "Mm-hmm.", at, endAt: at + 500, final: true });
  // A pause before any finished caller line: nothing to judge, and later pauses still run.
  w.check();
  await Bun.sleep(5);
  expect(judged).toEqual([]);
  w.add(say(1, 1000));
  w.check();
  w.check(); // while it runs: once more after
  await Bun.sleep(5);
  expect(judged).toEqual([1, 1]);
  answers = { start: 0.9 };
  w.add(reply(2, 2000));
  w.add(say(3, 4000));
  w.check();
  await Bun.sleep(5);
  expect(met).toEqual([{ at: 4000, endAt: 4500 }]); // the caller's line that did it
  w.add(say(4, 6000));
  w.check();
  await w.final();
  expect(judged).toEqual([1, 1, 3]); // no more once it's met
  expect(logged).toHaveLength(3);
  expect(met).toHaveLength(1);
});

test("the call's log says what a game scored, or why it didn't", () => {
  const started = goalMet(START, "scam", line(31_000, 30_100));
  expect(playSummary("scam", caught(started, 38_500), 120_000, x)).toBe("start 30.1s · caught 38.5s · ended 120.0s → score 983 points");
  expect(playSummary("scam", caught(START, 38_500), 120_000, x)).toBe("start — · caught 38.5s · ended 120.0s → no score (never started the scam)");
  expect(playSummary("get_through", START, 60_000, x)).toBe("message — · caught — → no score (message not passed on)");
  expect(playSummary("get_through", goalMet(caught(START, 5000), "get_through", line(9000)), 60_000, x)).toBe(
    "message 9.0s · caught 5.0s → no score (caught before the message)",
  );
});

test("the lean runs from genuine (-1) to scam or spam (1)", () => {
  expect(run(classification("genuine", 1)).lean).toBeCloseTo(-1);
  expect(run(classification("scam", 1)).lean).toBeCloseTo(1);
  expect(run(classification("unclear", 1)).verdict).toBeNull();
});

test("ranks against every score on the board: longest wins at scam me, fastest at get through", () => {
  const board = [{ player: "ANN", scoreMs: 50_000 }, { player: "BOB", scoreMs: 30_000 }];
  expect(rankIn("scam", board, 40_000)).toBe(2);
  expect(rankIn("scam", board, 60_000)).toBe(1);
  expect(rankIn("get_through", board, 40_000)).toBe(2); // ties don't beat you
  expect(rankIn("get_through", board, 20_000)).toBe(1);
});

test("player names: 1–3 letters or digits, stored in capitals", () => {
  expect(playerName(" kev ")).toBe("KEV");
  expect(playerName("r2")).toBe("R2");
  expect(playerName("")).toBeNull();
  expect(playerName("abcd")).toBeNull();
  expect(playerName("k-v")).toBeNull();
  expect(playerName(7)).toBeNull();
});

test("leaderboards keep every score, a player's several too; unscored games don't count", async () => {
  const repo = new SqliteRepo(openSqlite(":memory:"));
  const play = async (id: string, game: "scam" | "get_through", player: string, scoreMs: number | null) => {
    await repo.createCall({ id, callControlId: id, from: "public", to: "public page", divertedFrom: null, startedAt: 0 });
    await repo.createPlay({ callId: id, game, goal: "g", player, createdAt: 0 });
    await repo.finishPlay(id, scoreMs, 1);
  };
  await play("1", "scam", "ANN", 30_000);
  await play("2", "scam", "ANN", 10_000);
  await play("3", "scam", "BOB", 50_000);
  await play("4", "scam", "CAT", null);
  await play("5", "get_through", "ANN", 40_000);
  await play("6", "get_through", "BOB", 20_000);
  await play("7", "get_through", "BOB", 25_000);
  expect(await repo.scores("scam", "g")).toEqual([
    { player: "BOB", scoreMs: 50_000 },
    { player: "ANN", scoreMs: 30_000 },
    { player: "ANN", scoreMs: 10_000 },
  ]);
  expect(await repo.scores("get_through", "g")).toEqual([
    { player: "BOB", scoreMs: 20_000 },
    { player: "BOB", scoreMs: 25_000 },
    { player: "ANN", scoreMs: 40_000 },
  ]);
  expect(await repo.getPlay("4")).toMatchObject({ player: "CAT", scoreMs: null, finishedAt: 1 });
});

test("games.yaml's caught stages must be call-flow.yaml rules", () => {
  expect(() => checkGames(games, cfg.flow)).not.toThrow();
  expect(() => checkGames({ ...games, scam: { ...games.scam, caught_stages: ["waste_time", "nope"] } }, cfg.flow)).toThrow(ConfigError);
});

test("the referee's Jev request: the goal in the state, the game's yes/no questions", () => {
  const goal = games.scam.goals.find((g) => g.id === "police")!;
  const req = buildRefereeRequest({
    game: "scam",
    goal,
    transcript: [{ seq: 1, speaker: "caller", text: "Police here.", at: 0, final: true }],
    config: games.referee,
  });
  expect(req.state.goal).toContain(goal.start);
  expect(req.state.transcript).toBe("caller: Police here.");
  expect(Object.keys(req.questions)).toEqual(["start"]);
});
