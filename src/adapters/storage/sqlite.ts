import { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { demoStats, type AnalyticsSummary, type Count, type Listen, type PageEventRecord, type VisitSummary } from "../../core/analytics";
import type { BoardEntry, Game } from "../../core/game";
import type { CallFilter, CallRecord, NotifySignup, PlayRecord, Repo, StoredEvent } from "../../core/ports";
import type { Channel } from "../../core/limits";
import type { CallEvent } from "../../core/types";
import * as schema from "./schema";

export function openSqlite(path: string, migrationsFolder = "./drizzle"): BunSQLiteDatabase<typeof schema> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  // Waits out another connection's brief locks (WAL checkpoints, a backup's) instead of failing at once.
  sqlite.run("PRAGMA busy_timeout = 5000;");
  sqlite.run("PRAGMA journal_mode = WAL;");
  // With WAL: no fsync per commit; an app crash loses nothing, a power cut at most the last commits.
  sqlite.run("PRAGMA synchronous = NORMAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export class SqliteRepo implements Repo {
  constructor(private db: BunSQLiteDatabase<typeof schema>) {}

  async createCall(rec: Parameters<Repo["createCall"]>[0]) {
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

  async listCalls(limit: number, filter: CallFilter = {}) {
    const c = schema.calls;
    const where = and(
      filter.channel ? eq(c.channel, filter.channel) : undefined,
      filter.verdict ? eq(c.verdict, filter.verdict) : undefined,
    );
    return this.db.select().from(c).where(where).orderBy(desc(c.startedAt)).limit(limit).all();
  }

  async listOpenCalls() {
    return this.db.select().from(schema.calls).where(ne(schema.calls.status, "ended")).all();
  }

  async listCallsByChannel(channel: Channel, since: number) {
    const c = schema.calls;
    return this.db
      .select()
      .from(c)
      .where(and(eq(c.channel, channel), or(gte(c.startedAt, since), gte(c.endedAt, since))))
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

  async addNotifySignup(s: NotifySignup) {
    const { email: _, list: __, ...fresh } = s;
    // Signing up again refreshes the row and makes it pending again, even if mailed already.
    this.db
      .insert(schema.notifySignups)
      .values(s)
      .onConflictDoUpdate({ target: [schema.notifySignups.email, schema.notifySignups.list], set: { ...fresh, notifiedAt: null } })
      .run();
  }

  async addPageEvents(rows: PageEventRecord[]) {
    if (rows.length) this.db.insert(schema.pageEvents).values(rows).run();
  }

  /**
   * Each visit's listening per recording: a `watch` event's totals only grow over a page load, so
   * the largest per (visit, load, recording) counts, and a visit's loads add up.
   */
  private listens(since: number): Listen[] {
    const rows = this.db.all<{ visitId: string; demo: string; seconds: number; completed: number }>(sql`
      WITH w AS (
        SELECT visit_id, load_id, demo,
          MAX(coalesce(json_extract(props, '$.playedSeconds'), 0)) AS played,
          MAX(coalesce(json_extract(props, '$.completed'), 0)) AS completed
        FROM page_events WHERE type = 'watch' AND demo IS NOT NULL AND at >= ${since}
        GROUP BY visit_id, load_id, demo)
      SELECT visit_id AS visitId, demo, SUM(played) AS seconds, MAX(completed) AS completed FROM w GROUP BY visit_id, demo`);
    return rows.map((r) => ({ visitId: r.visitId, demo: r.demo, seconds: Number(r.seconds) || 0, completed: !!r.completed }));
  }

  /** Visits with events at or after `since`, newest first; `source`/`refHost` are from the visit's first view. */
  private visits(since: number, limit = -1) {
    return this.db.all<{
      visitId: string;
      firstAt: number;
      lastAt: number;
      ip: string | null;
      country: string | null;
      city: string | null;
      mobile: number | null;
      device: string | null;
      browser: string | null;
      os: string | null;
      views: number;
      clicks: number;
      source: string | null;
      refHost: string | null;
    }>(sql`
      SELECT visit_id AS visitId, MIN(at) AS firstAt, MAX(at) AS lastAt, MAX(ip) AS ip, MAX(country) AS country, MAX(city) AS city,
        MAX(mobile) AS mobile, MAX(device) AS device, MAX(browser) AS browser, MAX(os) AS os, SUM(type = 'view') AS views, SUM(type = 'click') AS clicks,
        (SELECT json_extract(v.props, '$.source') FROM page_events v WHERE v.visit_id = e.visit_id AND v.type = 'view' ORDER BY v.at LIMIT 1) AS source,
        (SELECT json_extract(v.props, '$.refHost') FROM page_events v WHERE v.visit_id = e.visit_id AND v.type = 'view' ORDER BY v.at LIMIT 1) AS refHost
      FROM page_events e WHERE at >= ${since} GROUP BY visit_id ORDER BY firstAt DESC LIMIT ${limit}`);
  }

  async pageStats(since: number, demos: readonly string[]): Promise<AnalyticsSummary> {
    const listens = this.listens(since);
    const plays = this.db.all<{ demo: string; n: number }>(sql`
      SELECT demo, COUNT(*) AS n FROM page_events
      WHERE type = 'play' AND demo IS NOT NULL AND at >= ${since} AND coalesce(json_extract(props, '$.position'), 0) < 1
      GROUP BY demo`);
    const clicks = this.db.all<{ action: string; target: string; n: number }>(sql`
      SELECT coalesce(json_extract(props, '$.action'), '?') AS action, coalesce(json_extract(props, '$.target'), '') AS target, COUNT(*) AS n
      FROM page_events WHERE type = 'click' AND at >= ${since} GROUP BY 1, 2 ORDER BY n DESC, action LIMIT 30`);
    const days = this.db.all<{ day: string; visits: number; views: number; listeners: number }>(sql`
      SELECT date(at / 1000, 'unixepoch') AS day, COUNT(DISTINCT visit_id) AS visits, SUM(type = 'view') AS views,
        COUNT(DISTINCT CASE WHEN type = 'watch' AND json_extract(props, '$.playedSeconds') >= 1 THEN visit_id END) AS listeners
      FROM page_events WHERE at >= ${since} GROUP BY day ORDER BY day`);
    const visits = this.visits(since);
    const views = visits.reduce((n, v) => n + v.views, 0);
    const heard = listens.filter((l) => l.seconds >= 1);
    return {
      visits: visits.length,
      views,
      listeningVisits: new Set(heard.map((l) => l.visitId)).size,
      listenSeconds: listens.reduce((n, l) => n + l.seconds, 0),
      demos: demoStats(listens, new Map(plays.map((p) => [p.demo, p.n])), demos),
      clicks,
      sources: tally(visits.filter((v) => v.views).map((v) => v.source ?? "(direct)")),
      referrers: tally(visits.flatMap((v) => (v.refHost ? [v.refHost] : []))),
      countries: tally(visits.map((v) => v.country ?? "?")),
      devices: tally(visits.map((v) => v.device ?? (v.mobile === null ? "?" : v.mobile ? "mobile" : "desktop"))),
      browsers: tally(visits.map((v) => v.browser ?? "?")),
      oses: tally(visits.map((v) => v.os ?? "?")),
      days,
    };
  }

  async pageVisits(since: number, limit: number): Promise<VisitSummary[]> {
    const visits = this.visits(since, limit);
    const listens = this.listens(since);
    return visits.map((v) => ({
      visitId: v.visitId,
      firstAt: v.firstAt,
      lastAt: v.lastAt,
      source: v.source,
      ip: v.ip,
      country: v.country,
      city: v.city,
      mobile: v.mobile === null ? null : !!v.mobile,
      browser: v.browser,
      os: v.os,
      views: v.views,
      clicks: v.clicks,
      listened: listens.filter((l) => l.visitId === v.visitId && l.seconds >= 1).map((l) => ({ demo: l.demo, seconds: l.seconds })),
    }));
  }

  async pageVisit(visitId: string): Promise<PageEventRecord[]> {
    const e = schema.pageEvents;
    const rows = this.db.select().from(e).where(eq(e.visitId, visitId)).orderBy(asc(e.at), asc(e.id)).all();
    return rows.map(({ id: _, ...r }) => r);
  }

  async prunePageEvents(before: number) {
    const e = schema.pageEvents;
    return this.db.delete(e).where(lt(e.at, before)).returning({ id: e.id }).all().length;
  }
}

/** counts of each value, most first */
function tally(values: string[]): Count[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
