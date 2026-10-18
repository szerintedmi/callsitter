import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { formatText, setLogSink, type LogLevel, type LogRecord } from "../core/log";
import type { LogBuffer } from "../web/debug-log";

// Where log lines go: stdout (human-readable, for `docker logs` and the dev terminal), the test-call
// page's debug panel, and JSON Lines files on the data volume (config/logging.yaml).

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_DATE = /^(?:app|call)-(\d{4}-\d{2}-\d{2})[-.]/;
/** files kept open (today's app file and the calls being logged); the least recently written is closed */
const MAX_OPEN = 32;

/** UTC date, e.g. 2026-09-27. */
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** whether an open file still has a name (false if it can't be checked either) */
const linked = (fd: number) => {
  try {
    return fstatSync(fd).nlink > 0;
  } catch {
    return false;
  }
};

/**
 * JSON Lines files in `dir`: app-<date>.jsonl gets every line, and call-<date>-<call id>.jsonl a
 * call's lines, dated by the call's first line so a call past midnight stays in one file. Lines are
 * written straight to the file (no buffer, so a crash loses none) through handles kept open.
 */
export class LogFiles {
  private callDays = new Map<string, string>();
  /** open files by path, least recently written first */
  private fds = new Map<string, number>();
  private failing = false;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  write(r: LogRecord) {
    const { time, ...rest } = r;
    const line = Buffer.from(`${JSON.stringify({ time: new Date(time).toISOString(), ...rest })}\n`);
    try {
      this.append(join(this.dir, `app-${dayOf(time)}.jsonl`), line);
      if (r.callId) this.append(this.callFile(r.callId, time), line);
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
        this.close(join(this.dir, name));
        rmSync(join(this.dir, name), { force: true });
        gone.push(name);
      }
    }
    // Calls don't last a day: older first-line dates aren't needed any more.
    const yesterday = dayOf(now - DAY_MS);
    for (const [id, day] of this.callDays) if (day < yesterday) this.callDays.delete(id);
    return gone;
  }

  /** Closes the open files; the next line opens its file again. */
  closeAll() {
    for (const path of [...this.fds.keys()]) this.close(path);
  }

  private append(path: string, line: Buffer) {
    let fd = this.fds.get(path);
    // Deleted under us (by hand): written to, it would take the lines with it.
    if (fd !== undefined && !linked(fd)) {
      this.close(path);
      fd = undefined;
    }
    if (fd === undefined) {
      fd = openSync(path, "a");
      if (this.fds.size >= MAX_OPEN) this.close(this.fds.keys().next().value!);
    } else this.fds.delete(path);
    this.fds.set(path, fd);
    try {
      for (let at = 0; at < line.length; ) {
        const n = writeSync(fd, line, at);
        if (n <= 0) throw new Error(`short write to ${path}`);
        at += n;
      }
    } catch (err) {
      // A failed write (a full disk) opens the file afresh on the next line.
      this.close(path);
      throw err;
    }
  }

  private close(path: string) {
    const fd = this.fds.get(path);
    if (fd === undefined) return;
    this.fds.delete(path);
    try {
      closeSync(fd);
    } catch {}
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
