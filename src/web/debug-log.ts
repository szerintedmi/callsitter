// Recent server log lines, for the debug panel on the test-call page (/debug/log). The
// runtime mirrors console output into it, so the panel shows exactly what the terminal shows.

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  seq: number;
  at: number;
  level: LogLevel;
  text: string;
}

export class LogBuffer {
  private lines: LogLine[] = [];
  private seq = 0;

  constructor(private max = 500) {}

  push(level: LogLevel, text: string, at = Date.now()) {
    this.lines.push({ seq: ++this.seq, at, level, text });
    if (this.lines.length > this.max) this.lines.shift();
  }

  /** Lines after `seq`, oldest first. */
  after(seq: number): LogLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }

  get last(): number {
    return this.seq;
  }
}

/** Mirrors console.log/info/warn/error into `buf` (still printing as before). */
export function mirrorConsole(buf: LogBuffer) {
  const levels = { log: "info", info: "info", warn: "warn", error: "error" } as const;
  for (const [method, level] of Object.entries(levels) as [keyof typeof levels, LogLevel][]) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      orig(...args);
      try {
        buf.push(level, args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(" "));
      } catch {}
    };
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
