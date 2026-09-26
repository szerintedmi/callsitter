import { integer, real, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import type { CallCosts } from "../../core/types";

export const calls = sqliteTable("calls", {
  id: text("id").primaryKey(),
  callControlId: text("call_control_id").notNull(),
  from: text("from").notNull(),
  to: text("to").notNull(),
  divertedFrom: text("diverted_from"),
  // Public page calls: the visitor's IP (Cloudflare's CF-Connecting-IP).
  callerIp: text("caller_ip"),
  status: text("status", { enum: ["ringing", "active", "ended"] }).notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  endReason: text("end_reason"),
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
});

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

export type CallRow = typeof calls.$inferSelect;
export type EventRow = typeof events.$inferSelect;
