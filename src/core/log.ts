// Application logging. Call sites log through `logger(scope)`; the runtime sets the sink (stdout,
// the debug panel, JSON Lines files). Field names follow the OpenTelemetry logs data model: `time`
// is Timestamp, `level` SeverityText, `msg` Body, and the other fields are Attributes.

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  /** epoch ms */
  time: number;
  level: LogLevel;
  /** the subsystem, e.g. call, telnyx, sip, owner */
  scope: string;
  msg: string;
  callId?: string;
  /** the error's message, and its stack when it was an Error */
  err?: string;
  stack?: string;
  [field: string]: unknown;
}

/** Extra fields; `err` takes any thrown value. */
export type LogFields = { callId?: string; err?: unknown; [field: string]: unknown };

export type LogSink = (r: LogRecord) => void;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** The same scope with more fields on every line (e.g. the call id). */
  with(fields: LogFields): Logger;
}

const PRINT = { info: "log", warn: "warn", error: "error" } as const;
const consoleSink: LogSink = (r) => console[PRINT[r.level]](formatText(r));
let sink: LogSink = consoleSink;

/** Sends every log line to `next` instead of the console; returns a function that restores the previous sink. */
export function setLogSink(next: LogSink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}

export function logger(scope: string, base: LogFields = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    const { err, ...rest } = { ...base, ...fields };
    const r: LogRecord = { time: Date.now(), level, scope, msg, ...rest };
    if (err !== undefined) {
      r.err = err instanceof Error ? err.message : typeof err === "string" ? err : safeJson(err);
      if (err instanceof Error && err.stack) r.stack = err.stack;
    }
    try {
      sink(r);
    } catch {}
  };
  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    with: (fields) => logger(scope, { ...base, ...fields }),
  };
}

/** One human-readable line (stdout, the debug panel): `[scope callId] msg: err (key=value, …)`, then the stack for errors. */
export function formatText(r: LogRecord): string {
  const { time: _t, level, scope, msg, callId, err, stack, ...rest } = r;
  const extra = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : safeJson(v)}`);
  let line = `[${scope}${callId ? ` ${callId}` : ""}] ${msg}${err ? `: ${err}` : ""}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  if (level === "error" && stack) line += `\n${stack}`;
  return line;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
