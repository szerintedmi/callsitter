import { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, ne } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallRecord, Repo, StoredEvent } from "../../core/ports";
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
}
