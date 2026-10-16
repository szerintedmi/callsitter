import { integer, real, sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Device, PageEventType, PropValue } from "../../core/analytics";
import type { CallCosts, EndedBy } from "../../core/types";

export const calls = sqliteTable(
  "calls",
  {
    id: text("id").primaryKey(),
    callControlId: text("call_control_id").notNull(),
    from: text("from").notNull(),
    to: text("to").notNull(),
    divertedFrom: text("diverted_from"),
    // Where the call came from (src/core/limits.ts Channel).
    channel: text("channel", { enum: ["phone", "test", "public"] }).notNull().default("phone"),
    // A limit (limits.yaml) it was declined for, without being answered; null: admitted.
    declined: text("declined", { enum: ["busy", "per_caller", "quota", "budget"] }),
    // Public page calls: the visitor's IP (Cloudflare's CF-Connecting-IP).
    callerIp: text("caller_ip"),
    status: text("status", { enum: ["ringing", "active", "ended"] }).notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    endReason: text("end_reason"),
    // Who ended it (EndedBy); null on calls from before it was recorded.
    endedBy: text("ended_by").$type<EndedBy>(),
    verdict: text("verdict"),
    // The column predates the call flow (it held the strategy id); a stage is the same idea.
    stage: text("strategy"),
    lunaCalls: integer("luna_calls").notNull().default(0),
    // The call's total cost, and broken down by vendor with the tokens (CallCosts). costs is null
    // on calls from before costs were recorded, which only have the estimate in cost_usd.
    costUsd: real("cost_usd"),
    costs: text("costs", { mode: "json" }).$type<CallCosts>(),
    summary: text("summary"),
    recordingPath: text("recording_path"),
  },
  (t) => [index("calls_channel_idx").on(t.channel, t.startedAt)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    callId: text("call_id")
      .notNull()
      .references(() => calls.id),
    at: integer("at").notNull(),
    type: text("type").notNull(),
    data: text("data", { mode: "json" }).notNull(),
  },
  (t) => [index("events_call_idx").on(t.callId, t.id)],
);

// Public page games (src/core/game.ts): one per public call, scored once the call ends.
export const plays = sqliteTable(
  "plays",
  {
    callId: text("call_id")
      .primaryKey()
      .references(() => calls.id),
    game: text("game", { enum: ["scam", "get_through"] }).notNull(),
    goal: text("goal").notNull(),
    player: text("player").notNull(),
    // null until the call ends, and after if the player didn't make it
    scoreMs: integer("score_ms"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("plays_board_idx").on(t.game, t.goal, t.scoreMs)],
);

// Public page visitors who left their email: to hear when there's game again (POST call/notify),
// or when they can get their own bot (POST call/waitlist). One row per email and list.
export const notifySignups = sqliteTable(
  "notify_signups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // trimmed, lowercased
    email: text("email").notNull(),
    list: text("list", { enum: ["notify", "waitlist"] }).notNull().default("notify"),
    createdAt: integer("created_at").notNull(),
    // Cloudflare's CF-Connecting-IP
    ip: text("ip"),
    // Cloudflare's CF-IPCountry, if it sends it
    country: text("country"),
    // cut to 300 characters
    userAgent: text("user_agent"),
    // notify: what had run out then; null: nothing, and always on the waitlist
    reason: text("reason", { enum: ["closed", "quota", "budget"] }),
    // for whoever sends the mail later; cleared when the email signs up again
    notifiedAt: integer("notified_at"),
  },
  (t) => [uniqueIndex("notify_signups_email_list_unique").on(t.email, t.list)],
);

// The public site's page analytics (src/core/analytics.ts).
export const pageEvents = sqliteTable(
  "page_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // random, per browser tab (sessionStorage), and per page load
    visitId: text("visit_id").notNull(),
    loadId: text("load_id").notNull(),
    at: integer("at").notNull(),
    type: text("type").$type<PageEventType>().notNull(),
    path: text("path"),
    demo: text("demo"),
    props: text("props", { mode: "json" }).$type<Record<string, PropValue>>().notNull(),
    // Cloudflare's CF-Connecting-IP
    ip: text("ip"),
    userAgent: text("user_agent"),
    // parsed from the user agent
    browser: text("browser"),
    browserVersion: text("browser_version"),
    os: text("os"),
    osVersion: text("os_version"),
    device: text("device").$type<Device>(),
    mobile: integer("mobile", { mode: "boolean" }),
    acceptLanguage: text("accept_language"),
    // Cloudflare's CF-IPCountry, CF-IPCity, CF-Region
    country: text("country"),
    city: text("city"),
    region: text("region"),
  },
  (t) => [index("page_events_at_idx").on(t.at), index("page_events_visit_idx").on(t.visitId, t.at)],
);

export type CallRow = typeof calls.$inferSelect;
export type EventRow = typeof events.$inferSelect;
