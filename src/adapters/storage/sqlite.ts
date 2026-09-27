import { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardEntry, Game } from "../../core/game";
import type { CallRecord, PlayRecord, Repo, StoredEvent } from "../../core/ports";
import type { CallEvent } from "../../core/types";
import * as schema from "./schema";

export function openSqlite(path: string, migrationsFolder = "./drizzle"): BunSQLiteDatabase<typeof schema> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export class SqliteRepo implements Repo {
  constructor(private db: BunSQLiteDatabase<typeof schema>) {}

  async createCall(rec: Pick<CallRecord, "id" | "callControlId" | "from" | "to" | "divertedFrom" | "startedAt"> & { callerIp?: string | null }) {
    this.db
      .insert(schema.calls)
      .values({ ...rec, status: "ringing" })
      .onConflictDoNothing()
      .run();
  }

  async updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>) {
    if (Object.keys(patch).length === 0) return;
    this.db.update(schema.calls).set(patch).where(eq(schema.calls.id, id)).run();
  }

  async getCall(id: string) {
    return this.db.select().from(schema.calls).where(eq(schema.calls.id, id)).get() ?? null;
  }

  async findByCallControlId(callControlId: string) {
    return (
      this.db.select().from(schema.calls).where(eq(schema.calls.callControlId, callControlId)).get() ?? null
    );
  }

  async listCalls(limit: number) {
    return this.db.select().from(schema.calls).orderBy(desc(schema.calls.startedAt)).limit(limit).all();
  }

  async listOpenCalls() {
    return this.db.select().from(schema.calls).where(ne(schema.calls.status, "ended")).all();
  }

  async listCallsFrom(from: string, since: number) {
    return this.db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.from, from), gte(schema.calls.startedAt, since)))
      .all();
  }

  async appendEvent(ev: CallEvent, patch?: Partial<Omit<CallRecord, "id">>) {
    this.db.transaction((tx) => {
      tx.insert(schema.events).values({ callId: ev.callId, at: Date.now(), type: ev.type, data: ev }).run();
      if (patch && Object.keys(patch).length) tx.update(schema.calls).set(patch).where(eq(schema.calls.id, ev.callId)).run();
    });
  }

  async listEvents(callId: string): Promise<StoredEvent[]> {
    const rows = this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.callId, callId))
      .orderBy(asc(schema.events.id))
      .all();
    return rows.map((r) => ({ id: r.id, callId: r.callId, at: r.at, event: r.data as CallEvent }));
  }

  async createPlay(p: Pick<PlayRecord, "callId" | "game" | "goal" | "player" | "createdAt">) {
    this.db.insert(schema.plays).values(p).onConflictDoNothing().run();
  }

  async finishPlay(callId: string, scoreMs: number | null, finishedAt: number) {
    this.db.update(schema.plays).set({ scoreMs, finishedAt }).where(eq(schema.plays.callId, callId)).run();
  }

  async getPlay(callId: string) {
    return this.db.select().from(schema.plays).where(eq(schema.plays.callId, callId)).get() ?? null;
  }

  async scores(game: Game, goal: string): Promise<BoardEntry[]> {
    const p = schema.plays;
    // scam: longest wins; get_through: fastest wins. Ties: the earlier game first.
    const rows = this.db
      .select({ player: p.player, scoreMs: p.scoreMs })
      .from(p)
      .where(and(eq(p.game, game), eq(p.goal, goal), isNotNull(p.scoreMs)))
      .orderBy(game === "scam" ? desc(p.scoreMs) : asc(p.scoreMs), asc(p.finishedAt))
      .all();
    return rows.map((r) => ({ player: r.player, scoreMs: r.scoreMs! }));
  }

  async junkCallSeconds() {
    const c = schema.calls;
    // A "Scam me" game is a scammer's call however Jev judged it.
    const scamGames = this.db.select({ id: schema.plays.callId }).from(schema.plays).where(eq(schema.plays.game, "scam"));
    const row = this.db
      .select({ ms: sql<number>`coalesce(sum(${c.endedAt} - ${c.startedAt}), 0)` })
      .from(c)
      .where(and(eq(c.status, "ended"), or(inArray(c.verdict, ["scam", "spam"]), inArray(c.id, scamGames)), isNotNull(c.endedAt)))
      .get();
    return Math.round((row?.ms ?? 0) / 1000);
  }
}
