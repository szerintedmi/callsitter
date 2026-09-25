#!/usr/bin/env bun
// On-demand evals against the real vendors (evals/cases.yaml says what each kind checks).
//
//   bun run eval                     every case once
//   bun run eval jailbreak hungarian cases whose name contains any of these
//   bun run eval --kind live --runs 3
//   bun run eval --check             validate cases.yaml only, no API calls
//   bun run eval --config /tmp/cfg   try another config dir (default ./config)
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { YamlDirSource } from "../src/adapters/config/yaml-fs";
import { loadConfig } from "../src/core/config";
import { loadCases } from "./cases";
import { runJevCase } from "./jev";
import { Judge } from "./judge";
import { runLiveCase } from "./live";
import { runLunaCase } from "./luna";

export interface Outcome {
  pass: boolean;
  /** why it failed (or the judge's reason) */
  detail: string;
  /** what was produced, for the report */
  log: string;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    kind: { type: "string" },
    config: { type: "string", default: "./config" },
    runs: { type: "string", default: "1" },
    check: { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
  },
  allowPositionals: true,
});

const cases = await loadCases(`${import.meta.dir}/cases.yaml`);
const s = cases.settings;
const cfg = await loadConfig(new YamlDirSource(values.config!), { ownerName: s.owner_name, agentLanguages: s.agent_languages });
const runs = Math.max(1, Number(values.runs));

type Kind = "jev" | "live" | "luna";
const selected = (["jev", "live", "luna"] as const)
  .filter((k) => !values.kind || values.kind === k)
  .flatMap((kind) => cases[kind].map((c) => ({ kind: kind as Kind, c })))
  .filter(({ c }) => !positionals.length || positionals.some((p) => c.name.includes(p)));

if (values.check) {
  console.log(`cases OK: ${cases.jev.length} jev, ${cases.live.length} live, ${cases.luna.length} luna`);
  process.exit(0);
}
if (!selected.length) {
  console.error("no cases match");
  process.exit(2);
}

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};
const openai = selected.some((x) => x.kind !== "jev") ? need("OPENAI_API_KEY") : "";
const typesafe = selected.some((x) => x.kind === "jev") ? need("TYPESAFE_API_KEY") : "";
let judge: Judge | undefined; // only for live and luna cases
const getJudge = () => (judge ??= new Judge(openai, s.judge_model));

async function runOne(kind: Kind, c: (typeof selected)[number]["c"]): Promise<Outcome> {
  try {
    if (kind === "jev") return await runJevCase(c as (typeof cases.jev)[number], cfg, typesafe);
    if (kind === "live") return await runLiveCase(c as (typeof cases.live)[number], cfg, s, openai, getJudge());
    return await runLunaCase(c as (typeof cases.luna)[number], cfg, openai, getJudge());
  } catch (err) {
    return { pass: false, detail: `error: ${err instanceof Error ? err.message : String(err)}`, log: "" };
  }
}

// A few at a time: live cases run in real time (~15 s each).
const CONCURRENCY = 4;
const jobs = selected.flatMap((x) => Array.from({ length: runs }, (_, run) => ({ ...x, run })));
const results: { kind: Kind; name: string; run: number; outcome: Outcome }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const outcome = await runOne(job.kind, job.c);
      results.push({ kind: job.kind, name: job.c.name, run: job.run, outcome });
      console.log(`${outcome.pass ? "✓" : "✗"} ${job.kind} ${job.c.name}${runs > 1 ? ` #${job.run + 1}` : ""}: ${outcome.detail}`);
      if (values.verbose || !outcome.pass) if (outcome.log) console.log(indent(outcome.log));
    }
  }),
);

console.log("\nSummary");
let failed = 0;
for (const { kind, c } of selected) {
  const mine = results.filter((r) => r.name === c.name);
  const passed = mine.filter((r) => r.outcome.pass).length;
  if (passed < mine.length) failed++;
  console.log(`  ${passed === mine.length ? "✓" : "✗"} ${passed}/${mine.length}  ${kind.padEnd(4)} ${c.name}`);
}
const out = `${import.meta.dir}/.out`;
await mkdir(out, { recursive: true });
const file = `${out}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(file, JSON.stringify(results, null, 2));
console.log(`\n${selected.length - failed}/${selected.length} cases passed every run · details: ${file}`);
process.exit(failed ? 1 : 0);

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
