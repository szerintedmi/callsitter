import { JevClassifier } from "../src/adapters/jev/classifier";
import type { AppConfig } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import { Orchestrator } from "../src/core/orchestrator";
import type { CallEvent } from "../src/core/types";
import { stubAgent } from "../src/replay/harness";
import { compare, parseJevTranscript, type Check } from "./cases";
import type { Outcome } from "./run";

type Classified = Extract<CallEvent, { type: "classification" }>;

/**
 * A transcript through real Jev and the real call flow, line by line (like src/replay/harness.ts),
 * checking Jev's answer after the caller lines that have checks. Luna is stubbed.
 */
export async function runJevCase(c: { transcript: string }, cfg: AppConfig, apiKey: string): Promise<Outcome> {
  const steps = parseJevTranscript(c.transcript);
  let now = Date.now();
  const startedAt = now;
  const bus = new MemoryEventBus();
  let last: Classified | null = null;
  bus.subscribe((ev) => {
    if (ev.type === "classification") last = ev;
  });
  const orch = new Orchestrator({
    meta: { callId: "eval", from: "+440000000000", to: "+440000000001", startedAt },
    config: () => cfg,
    classifier: new JevClassifier({ apiKey }),
    agent: stubAgent,
    bus,
    steer: { tellLive: () => {}, hangup: async () => {} },
    clock: { now: () => now },
    dryRun: true,
  });

  const failures: string[] = [];
  const log: string[] = [];
  try {
    for (const [i, { line, checks }] of steps.entries()) {
      now += 500 + line.text.length * 65; // rough speaking time
      last = null;
      orch.onTranscriptDelta(line.speaker, `u${i}`, line.text);
      orch.onTranscriptDone(line.speaker, `u${i}`);
      if (orch.pending) await orch.classify();
      await orch.idle();
      if (!checks.length) continue;
      const got = last as Classified | null;
      if (!got) {
        failures.push(`no Jev result after "${line.text}"`);
        continue;
      }
      log.push(`${line.speaker}: ${line.text}\n    ↳ ${describe(got, orch.stage)}`);
      for (const check of checks) {
        const miss = evaluate(check, got, orch.stage);
        if (miss) failures.push(`after "${short(line.text)}": ${check.src} (got ${miss})`);
      }
    }
  } finally {
    orch.end();
  }
  return { pass: failures.length === 0, detail: failures.join("; ") || "all checks hold", log: log.join("\n") };
}

/** null when the check holds, else what Jev (or the flow) actually gave. */
function evaluate(check: Check, ev: Classified, stage: string | null): string | null {
  switch (check.kind) {
    case "stage":
      return (stage ?? "none") === check.value ? null : `stage ${stage ?? "none"}`;
    case "rule":
      return ev.decision?.rule === check.value ? null : `rule ${ev.decision?.rule ?? "none"}`;
    case "choice": {
      const a = ev.classification.answers[check.question];
      if (!a) return `no answer for ${check.question}`;
      return a.choice === check.answer ? null : `${a.choice} ${fmt(a.probabilities[a.choice])}`;
    }
    case "prob": {
      const a = ev.classification.answers[check.question];
      if (!a) return `no answer for ${check.question}`;
      const p = a.probabilities[check.answer] ?? 0;
      return compare(p, check.op, check.value) ? null : fmt(p);
    }
  }
}

function describe(ev: Classified, stage: string | null): string {
  const answers = Object.entries(ev.classification.answers)
    .map(([q, a]) => `${q}: ${a.choice} ${fmt(a.probabilities[a.choice])}`)
    .join(" · ");
  return `${answers} → rule ${ev.decision?.rule ?? "none"}, stage ${stage ?? "none"}`;
}

const fmt = (p: number | undefined) => (p ?? 0).toFixed(2);
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
