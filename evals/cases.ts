import { parse } from "yaml";
import { z } from "zod";
import type { Speaker } from "../src/core/types";

// evals/cases.yaml: schema, and the `? …` check lines of jev cases.

const Settings = z.strictObject({
  owner_name: z.string(),
  agent_languages: z.string(),
  judge_model: z.string(),
  tts_model: z.string(),
  tts_voice: z.string(),
  live_quiet_ms: z.number().int().positive(),
  live_timeout_ms: z.number().int().positive(),
});

const JevCase = z.strictObject({ name: z.string(), transcript: z.string() });
const LiveCase = z.strictObject({
  name: z.string(),
  history: z.string(),
  told: z.array(z.string()).default([]),
  caller: z.string(),
  after_caller: z.array(z.string()).default([]),
  pass_if: z.string(),
});
const LunaCase = z.strictObject({
  name: z.string(),
  reason: z.string(),
  transcript: z.string(),
  // Jev's last result as Luna sees it; omitted: none yet.
  jev: z
    .strictObject({ verdict: z.enum(["scam", "spam", "genuine", "unclear"]), confidence: z.number().min(0).max(1), urgency: z.number().min(0).max(1) })
    .optional(),
  pass_if: z.string(),
});

const Cases = z.strictObject({
  settings: Settings,
  jev: z.array(JevCase).default([]),
  live: z.array(LiveCase).default([]),
  luna: z.array(LunaCase).default([]),
});

export type Settings = z.infer<typeof Settings>;
export type LiveCase = z.infer<typeof LiveCase>;
export type LunaCase = z.infer<typeof LunaCase>;
export type Cases = z.infer<typeof Cases>;

export interface Line {
  speaker: Speaker;
  text: string;
}

/**
 * A check on Jev's answer after a caller line: its choice for a question, its probability for
 * one answer, or the call flow's stage or matched rule.
 */
export type Check =
  | { kind: "choice"; question: string; answer: string; src: string }
  | { kind: "prob"; question: string; answer: string; op: Op; value: number; src: string }
  | { kind: "stage" | "rule"; value: string; src: string };

type Op = ">=" | "<=" | ">" | "<";

export interface JevStep {
  line: Line;
  checks: Check[];
}

export async function loadCases(path: string): Promise<Cases> {
  const cases = Cases.parse(parse(await Bun.file(path).text()));
  const names = [...cases.jev, ...cases.live, ...cases.luna].map((c) => c.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`duplicate case name: ${dup}`);
  for (const c of cases.jev) parseJevTranscript(c.transcript);
  for (const c of [...cases.live.map((c) => c.history), ...cases.luna.map((c) => c.transcript)]) parseLines(c);
  return cases;
}

/** "caller: …" / "agent: …" lines. */
export function parseLines(text: string): Line[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(caller|agent)\s*:\s*(.+)$/);
      if (!m) throw new Error(`expected "caller: …" or "agent: …": ${l}`);
      return { speaker: m[1] as Speaker, text: m[2]! };
    });
}

/** Transcript lines, each with the `? …` checks that follow it (only after caller lines). */
export function parseJevTranscript(text: string): JevStep[] {
  const steps: JevStep[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("?")) {
      const step = steps.at(-1);
      if (step?.line.speaker !== "caller") throw new Error(`a check must follow a caller line: ${l}`);
      step.checks.push(parseCheck(l.slice(1).trim()));
    } else {
      steps.push({ line: parseLines(l)[0]!, checks: [] });
    }
  }
  return steps;
}

function parseCheck(src: string): Check {
  let m = src.match(/^(stage|rule)\s*=\s*([a-z_]+)$/);
  if (m) return { kind: m[1] as "stage" | "rule", value: m[2]!, src };
  m = src.match(/^([a-z_]+)\s*=\s*([a-z_]+)$/);
  if (m) return { kind: "choice", question: m[1]!, answer: m[2]!, src };
  m = src.match(/^([a-z_]+)\.([a-z_]+)\s*(>=|<=|>|<)\s*([0-9.]+)$/);
  if (m) return { kind: "prob", question: m[1]!, answer: m[2]!, op: m[3] as Op, value: Number(m[4]), src };
  throw new Error(`bad check (e.g. "verdict = genuine", "ended.ended >= 0.85", "stage = waste_time"): ${src}`);
}

export function compare(actual: number, op: Op, value: number): boolean {
  return op === ">=" ? actual >= value : op === "<=" ? actual <= value : op === ">" ? actual > value : actual < value;
}
