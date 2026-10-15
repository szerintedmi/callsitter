import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import type { AppConfig, ChannelLimits } from "../src/core/config";
import { CallGate, callSecondsCap, type Channel } from "../src/core/limits";
import { loadRepoConfig } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
const NONE: ChannelLimits = {
  max_spend_usd_per_day: null,
  max_calls_per_day: null,
  max_concurrent_calls: null,
  max_calls_per_caller_per_day: null,
  max_call_seconds: null,
};

let cfg: AppConfig;
let repo: SqliteRepo;
let now: number;
const gate = () => new CallGate({ repo, config: () => cfg, clock: { now: () => now } });
const set = (ch: Channel, l: Partial<ChannelLimits>) => void (cfg.limits[ch] = { ...NONE, ...l });
let n = 0;
/** a stored call: ended with `costUsd`, or live (costUsd undefined) */
const stored = async (ch: Channel, o: { from?: string; ip?: string; costUsd?: number; startedAt?: number; declined?: "budget" } = {}) => {
  const id = `row${++n}`;
  const startedAt = o.startedAt ?? now - 60_000;
  await repo.createCall({ id, callControlId: id, from: o.from ?? "+441", to: "+442", divertedFrom: null, channel: ch, callerIp: o.ip ?? null, startedAt, declined: o.declined ?? null });
  if (o.costUsd !== undefined) await repo.updateCall(id, { status: "ended", endedAt: startedAt + 30_000, costUsd: o.costUsd });
  return id;
};

beforeEach(async () => {
  cfg = await loadRepoConfig();
  for (const ch of ["phone", "test", "public"] as const) set(ch, {});
  repo = new SqliteRepo(openSqlite(":memory:"));
  now = 10 * DAY_MS;
});

describe("call limits", () => {
  test("null is no limit", async () => {
    const g = gate();
    for (let i = 0; i < 5; i++) await stored("phone", { costUsd: 100 });
    for (let i = 0; i < 5; i++) expect(await g.admit({ callId: `c${i}`, channel: "phone", caller: "+441" })).toBeNull();
    expect(await g.exhausted("phone")).toBeNull();
  });

  test("spend: the ended calls of the last 24 h, refused once they reach the cap; live and declined calls don't count", async () => {
    set("phone", { max_spend_usd_per_day: 1 });
    const g = gate();
    await stored("phone", { costUsd: 0.6 });
    await stored("phone", { costUsd: 5, startedAt: now - DAY_MS - 60_000 }); // ended over a day ago
    await stored("phone", { costUsd: 5, declined: "budget" });
    await stored("phone"); // live, cost not known yet
    expect(await g.admit({ callId: "a", channel: "phone" })).toBeNull();
    await stored("phone", { costUsd: 0.4 });
    expect(await g.exhausted("phone")).toBe("budget");
    expect(await g.admit({ callId: "b", channel: "phone" })).toBe("budget");
    expect(await g.usage("phone")).toMatchObject({ spentUsd: 1, live: 1 });
    // 0 is a cap of 0, not "off".
    set("test", { max_spend_usd_per_day: 0 });
    expect(await g.admit({ callId: "t", channel: "test" })).toBe("budget");
  });

  test("channels are counted apart", async () => {
    set("phone", { max_spend_usd_per_day: 1, max_concurrent_calls: 1 });
    const g = gate();
    await stored("public", { costUsd: 50 });
    expect(await g.admit({ callId: "p1", channel: "phone" })).toBeNull();
    expect(await g.admit({ callId: "p2", channel: "phone" })).toBe("busy");
    expect(await g.admit({ callId: "w1", channel: "public" })).toBeNull();
    g.release("p1");
    expect(await g.admit({ callId: "p2", channel: "phone" })).toBeNull();
  });

  test("concurrent admits don't overshoot max_concurrent_calls or max_calls_per_day", async () => {
    set("public", { max_concurrent_calls: 2 });
    const g = gate();
    const hits = await Promise.all([1, 2, 3, 4].map((i) => g.admit({ callId: `c${i}`, channel: "public", caller: `10.0.0.${i}` })));
    expect(hits.filter((h) => h === null)).toHaveLength(2);
    expect(hits.filter((h) => h === "busy")).toHaveLength(2);

    set("phone", { max_calls_per_day: 3 });
    await stored("phone", { costUsd: 0 });
    // Each sees the others while the call list is read: none can slip past the cap.
    const day = await Promise.all([1, 2, 3, 4].map((i) => g.admit({ callId: `d${i}`, channel: "phone" })));
    expect(day.filter((h) => h === null).length).toBeLessThanOrEqual(2);
    expect(day.filter((h) => h !== null).every((h) => h === "quota")).toBe(true);
    // The refused ones were undone.
    while ((await g.usage("phone")).calls < 3) expect(await g.admit({ callId: `e${n++}`, channel: "phone" })).toBeNull();
    expect(await g.admit({ callId: "over", channel: "phone" })).toBe("quota");
    expect(await g.exhausted("phone")).toBe("quota");
  });

  test("per caller: stored calls and live ones; withheld numbers aren't counted; declined calls don't count", async () => {
    set("phone", { max_calls_per_caller_per_day: 2 });
    const g = gate();
    await stored("phone", { from: "+447700900001", costUsd: 0 });
    await stored("phone", { from: "+447700900001", costUsd: 0, declined: "budget" });
    expect(await g.admit({ callId: "a", channel: "phone", caller: "+447700900001" })).toBeNull();
    expect(await g.admit({ callId: "b", channel: "phone", caller: "+447700900001" })).toBe("per_caller");
    expect(await g.admit({ callId: "c", channel: "phone", caller: "+447700900002" })).toBeNull();
    for (const caller of [undefined, "", "anonymous"]) {
      await stored("phone", { from: caller ?? "", costUsd: 0 });
      await stored("phone", { from: caller ?? "", costUsd: 0 });
      expect(await g.admit({ callId: `w${caller}`, channel: "phone", caller })).toBeNull();
    }
    // A per-caller hit is per caller: it doesn't run out for everyone.
    expect(await g.exhausted("phone")).toBeNull();

    // Public: by client IP.
    set("public", { max_calls_per_caller_per_day: 1 });
    await stored("public", { from: "public", ip: "10.1.1.1", costUsd: 0 });
    expect(await g.admit({ callId: "p", channel: "public", caller: "10.1.1.1" })).toBe("per_caller");
    expect(await g.admit({ callId: "q", channel: "public", caller: "10.1.1.2" })).toBeNull();
  });

  test("a new gate on the same call list keeps the counts (a restart doesn't reset them)", async () => {
    set("phone", { max_calls_per_day: 1, max_calls_per_caller_per_day: 1 });
    await stored("phone", { from: "+447700900001", costUsd: 0 });
    expect(await gate().admit({ callId: "x", channel: "phone", caller: "+447700900009" })).toBe("quota");
    expect(await gate().exhausted("phone")).toBe("quota");
    now += DAY_MS;
    expect(await gate().admit({ callId: "y", channel: "phone", caller: "+447700900001" })).toBeNull();
  });

  test("max_call_seconds caps the call flow's, never raises it", () => {
    expect(callSecondsCap(cfg, "phone")).toBe(cfg.flow.timing.max_call_seconds);
    set("public", { max_call_seconds: 600 });
    expect(callSecondsCap(cfg, "public")).toBe(Math.min(600, cfg.flow.timing.max_call_seconds));
    set("public", { max_call_seconds: cfg.flow.timing.max_call_seconds + 100 });
    expect(callSecondsCap(cfg, "public")).toBe(cfg.flow.timing.max_call_seconds);
  });
});

test("the channel migration backfills calls from before it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scamsitter-migrate-"));
  try {
    // The migrations up to 0005, on a DB with calls from each channel.
    const before = join(dir, "before");
    cpSync("./drizzle", before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const last = journal.entries.findIndex((e: { tag: string }) => e.tag.endsWith("_call_channel"));
    journal.entries = journal.entries.slice(0, last);
    writeFileSync(journalPath, JSON.stringify(journal));
    const path = join(dir, "old.db");
    openSqlite(path, before);
    const old = new Database(path);
    for (const [id, from] of [["p", "public"], ["b", "browser"], ["s", "browser (SIP)"], ["r", "+447700900123"], ["u", ""]]) {
      old.run(`INSERT INTO calls (id, call_control_id, "from", "to", status, started_at) VALUES (?, ?, ?, 'x', 'ended', 1)`, [id!, id!, from!]);
    }
    old.close();

    const repo = new SqliteRepo(openSqlite(path));
    const channels = Object.fromEntries((await repo.listCalls(10)).map((c) => [c.id, [c.channel, c.declined]]));
    expect(channels).toEqual({ p: ["public", null], b: ["test", null], s: ["test", null], r: ["phone", null], u: ["phone", null] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
