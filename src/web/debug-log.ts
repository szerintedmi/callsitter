import type { LogLevel } from "../core/log";

// Recent server log lines, for the debug panel on the test-call page (/debug/log). The runtime's
// log sink (src/runtime/logging.ts) writes every line into it, as the terminal shows it.

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
