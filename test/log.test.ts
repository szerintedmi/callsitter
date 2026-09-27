import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatText, logger, setLogSink, type LogRecord } from "../src/core/log";
import { fromConsole, LogFiles } from "../src/runtime/logging";

const T = Date.parse("2026-09-27T23:59:58.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("logger", () => {
  let restore = () => {};
  afterEach(() => restore());

  const capture = () => {
    const lines: LogRecord[] = [];
    restore = setLogSink((r) => lines.push(r));
    return lines;
  };

  test("records scope, fields and the error's message and stack", () => {
    const lines = capture();
    logger("call", { callId: "c1" }).with({ stage: "wrap_up" }).warn("recording not saved", { err: new Error("disk full") });
    expect(lines).toHaveLength(1);
    const r = lines[0]!;
    expect(r).toMatchObject({ level: "warn", scope: "call", msg: "recording not saved", callId: "c1", stage: "wrap_up", err: "disk full" });
    expect(r.stack).toContain("disk full");
    expect(typeof r.time).toBe("number");
  });

  test("a string err stays as it is", () => {
    const lines = capture();
    logger("telnyx").error("answer failed", { err: "422 call not answered" });
    expect(lines[0]).toMatchObject({ err: "422 call not answered" });
    expect(lines[0]!.stack).toBeUndefined();
  });

  test("a throwing sink never reaches the caller", () => {
    restore = setLogSink(() => {
      throw new Error("sink down");
    });
    expect(() => logger("x").info("hello")).not.toThrow();
  });
});

describe("formatText", () => {
  test("[scope callId] msg: err (fields)", () => {
    const r: LogRecord = { time: T, level: "warn", scope: "call", callId: "c1", msg: "answer failed", err: "busy", codec: "pcma", format: { rate: 8000 } };
    expect(formatText(r)).toBe('[call c1] answer failed: busy (codec=pcma, format={"rate":8000})');
  });

  test("the stack follows for errors only", () => {
    const r: LogRecord = { time: T, level: "error", scope: "media", msg: "could not start session", err: "boom", stack: "Error: boom\n    at x" };
    expect(formatText(r)).toBe("[media] could not start session: boom\nError: boom\n    at x");
    expect(formatText({ ...r, level: "warn" })).toBe("[media] could not start session: boom");
  });
});

describe("fromConsole", () => {
  test("parses the [scope callId] prefix", () => {
    expect(fromConsole("warn", ["[call c1] recording not saved"], T)).toEqual({ time: T, level: "warn", scope: "call", callId: "c1", msg: "recording not saved" });
    expect(fromConsole("info", ["[test call c2] started"], T)).toMatchObject({ scope: "test call", callId: "c2", msg: "started" });
    expect(fromConsole("info", ["[startup] listening"], T)).toMatchObject({ scope: "startup", msg: "listening" });
    expect(fromConsole("info", ["[startup] listening"], T).callId).toBeUndefined();
  });

  test("anything else is scope console, with objects and errors printed", () => {
    const r = fromConsole("error", ["failed", { code: 1 }, new Error("boom")], T);
    expect(r.scope).toBe("console");
    expect(r.msg).toContain("failed");
    expect(r.msg).toContain("code: 1");
    expect(r.msg).toContain("Error: boom");
  });
});

describe("LogFiles", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = () => new LogFiles((dir = mkdtempSync(join(tmpdir(), "scamsitter-logs-"))));
  const lines = (name: string) =>
    readFileSync(join(dir, name), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  test("every line goes to the day's app file, a call's lines also to the call's file", () => {
    const files = make();
    files.write({ time: T, level: "info", scope: "startup", msg: "listening" });
    files.write({ time: T, level: "warn", scope: "call", callId: "c1", msg: "answer failed", err: "busy" });
    expect(readdirSync(dir).sort()).toEqual(["app-2026-09-27.jsonl", "call-2026-09-27-c1.jsonl"]);
    expect(lines("app-2026-09-27.jsonl")).toEqual([
      { time: "2026-09-27T23:59:58.000Z", level: "info", scope: "startup", msg: "listening" },
      { time: "2026-09-27T23:59:58.000Z", level: "warn", scope: "call", callId: "c1", msg: "answer failed", err: "busy" },
    ]);
    expect(lines("call-2026-09-27-c1.jsonl")).toHaveLength(1);
  });

  test("a call past midnight stays in the file of its first line; the app file moves on", () => {
    const files = make();
    files.write({ time: T, level: "info", scope: "call", callId: "c1", msg: "started" });
    files.write({ time: T + 5000, level: "info", scope: "call", callId: "c1", msg: "ended" });
    expect(lines("call-2026-09-27-c1.jsonl").map((l) => l.msg)).toEqual(["started", "ended"]);
    expect(readdirSync(dir).sort()).toEqual(["app-2026-09-27.jsonl", "app-2026-09-28.jsonl", "call-2026-09-27-c1.jsonl"]);
  });

  test("call ids can't leave the directory", () => {
    const files = make();
    files.write({ time: T, level: "info", scope: "call", callId: "../x/y", msg: "hi" });
    expect(readdirSync(dir)).toContain("call-2026-09-27-___x_y.jsonl");
  });

  test("prune deletes files dated more than `days` days ago and leaves other files alone", () => {
    const files = make();
    const now = Date.parse("2026-09-27T12:00:00Z");
    for (const name of ["app-2026-08-27.jsonl", "app-2026-08-28.jsonl", "call-2026-08-01-c9.jsonl", "call-2026-09-27-c1.jsonl", "notes.txt"]) {
      writeFileSync(join(dir, name), "");
    }
    expect(files.prune(30, now).sort()).toEqual(["app-2026-08-27.jsonl", "call-2026-08-01-c9.jsonl"]);
    expect(readdirSync(dir).sort()).toEqual(["app-2026-08-28.jsonl", "call-2026-09-27-c1.jsonl", "notes.txt"]);
    expect(files.prune(30, now + DAY)).toEqual(["app-2026-08-28.jsonl"]);
  });
});
