import { expect, test } from "bun:test";
import { buildRefereeRequest } from "../src/adapters/jev/referee";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { ConfigError, checkGames } from "../src/core/config";
import { START, goalMet, nextPlay, playerName, rankIn, scoreOf, type PlayState } from "../src/core/game";
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

/** a caller turn ending at `endAt` */
const turn = (endAt: number, at = endAt - 1000) => ({ at, endAt });

test("scam me scores from the move until caught, if they asked first; caught before the move scores nothing", () => {
  const caught = (s: PlayState, at: number) => nextPlay(s, stage(games.scam.caught_stages[0]!, at), games)!;
  const moved = goalMet(START, "move", turn(5000));
  const asked = goalMet(moved, "ask", turn(20_000));
  expect(scoreOf("scam", caught(asked, 35_000))).toBe(30_000);
  // Caught mid-ask: the ask counts from the start of that turn.
  expect(scoreOf("scam", caught(goalMet(moved, "ask", turn(40_000, 30_000)), 35_000))).toBe(30_000);
  // Caught before asking, or never asking: no score.
  expect(scoreOf("scam", caught(goalMet(moved, "ask", turn(40_000, 36_000)), 35_000))).toBeNull();
  expect(scoreOf("scam", caught(moved, 35_000))).toBeNull();
  // Only the first catch counts, even after the call recovers.
  const recovered = run(stage(games.scam.caught_stages[0]!, 8000), classification("genuine"), stage(games.scam.caught_stages[0]!, 12_000));
  expect(recovered.caughtAt).toBe(8000);
  expect(scoreOf("scam", goalMet(goalMet(recovered, "move", turn(10_000)), "ask", turn(11_000)))).toBeNull();
  expect(scoreOf("scam", caught(START, 8000))).toBeNull();
  expect(goalMet(moved, "move", turn(9000)).goalAt).toBe(5000);
});

test("scam me never caught scores until the end, only if they asked for what the goal wants", () => {
  const moved = goalMet(START, "move", turn(5000));
  expect(scoreOf("scam", moved, 65_000)).toBeNull();
  expect(scoreOf("scam", goalMet(moved, "ask", turn(40_000)), 65_000)).toBe(60_000);
});

test("get through scores when the message was passed on, unless caught first", () => {
  expect(scoreOf("get_through", goalMet(START, "message", turn(20_000)))).toBe(20_000);
  expect(scoreOf("get_through", goalMet(run(stage(games.scam.caught_stages[0]!, 10_000)), "message", turn(20_000)))).toBeNull();
  expect(scoreOf("get_through", START, 60_000)).toBeNull();
});

test("the referee judges each pause until every question is met, then once more when the call ends", async () => {
  const judged: number[] = [];
  let answers: Record<string, number> = { move: 0.1, ask: 0.1 };
  const met: [string, { at: number; endAt: number }][] = [];
  const logged: Record<string, number>[] = [];
  const w = new GoalWatch({
    referee: { judge: async (i) => (judged.push(i.transcript.length), answers) },
    game: "scam",
    goal: games.scam.goals[0]!,
    config: () => games.referee,
    onMet: (q, at) => met.push([q, at]),
    onJudged: (a) => logged.push(a),
    onError: (err) => { throw err; },
  });
  const say = (seq: number, at: number): TranscriptEntry => ({ seq, speaker: "caller", text: `line ${seq}`, at, endAt: at + 500, final: true });
  // A pause before any finished caller line: nothing to judge, and later pauses still run.
  w.check();
  await Bun.sleep(5);
  expect(judged).toEqual([]);
  w.add(say(1, 1000));
  w.check();
  w.check(); // while it runs: once more after
  await Bun.sleep(5);
  expect(judged).toEqual([1, 1]);
  answers = { move: 0.9, ask: 0.2 };
  w.add(say(2, 4000));
  w.check();
  await Bun.sleep(5);
  expect(met).toEqual([["move", { at: 4000, endAt: 4500 }]]); // the caller's turn that did it
  answers = { move: 0.9, ask: 0.8 };
  w.add(say(3, 9000));
  w.check();
  await Bun.sleep(5);
  expect(met).toEqual([["move", { at: 4000, endAt: 4500 }], ["ask", { at: 9000, endAt: 9500 }]]);
  w.check();
  await w.final();
  expect(judged).toEqual([1, 1, 2, 3]); // no more once all are met
  expect(logged).toHaveLength(4);
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
  expect(req.state.goal).toContain(goal.move);
  expect(req.state.goal).toContain(goal.ask);
  expect(req.state.transcript).toBe("caller: Police here.");
  expect(Object.keys(req.questions)).toEqual(["move", "ask"]);
});
