import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatText, setLogSink, type LogLevel, type LogRecord } from "../core/log";
import type { LogBuffer } from "../web/debug-log";

// Where log lines go: stdout (human-readable, for `docker logs` and the dev terminal), the test-call
// page's debug panel, and JSON Lines files on the data volume (config/logging.yaml).

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_DATE = /^(?:app|call)-(\d{4}-\d{2}-\d{2})[-.]/;

/** UTC date, e.g. 2026-09-27. */
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * JSON Lines files in `dir`: app-<date>.jsonl gets every line, and call-<date>-<call id>.jsonl a
 * call's lines, dated by the call's first line so a call past midnight stays in one file.
 */
export class LogFiles {
  private callDays = new Map<string, string>();
  private failing = false;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  write(r: LogRecord) {
    const { time, ...rest } = r;
    const line = `${JSON.stringify({ time: new Date(time).toISOString(), ...rest })}\n`;
    try {
      appendFileSync(join(this.dir, `app-${dayOf(time)}.jsonl`), line);
      if (r.callId) appendFileSync(this.callFile(r.callId, time), line);
      this.failing = false;
    } catch (err) {
      // Straight to stderr, once per outage: through the logger it would come back here.
      if (!this.failing) process.stderr.write(`[logging] writing to ${this.dir} failed: ${err instanceof Error ? err.message : err}\n`);
      this.failing = true;
    }
  }

  /** Deletes the files dated more than `days` days before `now`; returns their names. */
  prune(days: number, now = Date.now()): string[] {
    const cutoff = dayOf(now - days * DAY_MS);
    const gone: string[] = [];
    for (const name of readdirSync(this.dir)) {
      const date = FILE_DATE.exec(name)?.[1];
      if (date && date < cutoff) {
        rmSync(join(this.dir, name), { force: true });
        gone.push(name);
      }
    }
    // Calls don't last a day: older first-line dates aren't needed any more.
    const yesterday = dayOf(now - DAY_MS);
    for (const [id, day] of this.callDays) if (day < yesterday) this.callDays.delete(id);
    return gone;
  }

  private callFile(callId: string, time: number): string {
    let day = this.callDays.get(callId);
    if (!day) this.callDays.set(callId, (day = dayOf(time)));
    return join(this.dir, `call-${day}-${callId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  }
}

/**
 * Sends the logger's lines (src/core/log.ts) to stdout, `buffer` and `files`. console.* calls
 * made anywhere else (libraries, code not using the logger yet) go the same way, their
 * `[scope callId]` prefix parsed into fields.
 */
export function startLogging(buffer: LogBuffer, files?: LogFiles) {
  const print = { info: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const emit = (r: LogRecord) => {
    const text = formatText(r);
    print[r.level](text);
    buffer.push(r.level, text, r.time);
    files?.write(r);
  };
  setLogSink(emit);
  const methods = { log: "info", info: "info", warn: "warn", error: "error" } as const;
  for (const [method, level] of Object.entries(methods) as [keyof typeof methods, LogLevel][]) {
    console[method] = (...args: unknown[]) => {
      try {
        emit(fromConsole(level, args));
      } catch {}
    };
  }
}

const PREFIX = /^\[([a-z][a-z ]*?)(?: ([^\]\s]+))?\] ?/;

/** A console.* call as a log line: `[scope callId] text` → scope, callId and msg (the logger's own text format). */
export function fromConsole(level: LogLevel, args: unknown[], time = Date.now()): LogRecord {
  const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : Bun.inspect(a))).join(" ");
  const m = PREFIX.exec(text);
  if (!m) return { time, level, scope: "console", msg: text };
  return { time, level, scope: m[1]!, msg: text.slice(m[0].length), ...(m[2] ? { callId: m[2] } : {}) };
}
