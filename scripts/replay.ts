#!/usr/bin/env bun
// Replay a saved transcript through Jev → call flow (→ Luna) with no phone call.
//
//   bun run replay test/fixtures/scam-bank.txt           # real Jev (TYPESAFE_API_KEY), stub Luna
//   bun run replay test/fixtures/genuine-dentist.txt --luna   # also real Luna (OPENAI_API_KEY), tools dry-run
//   bun run replay test/fixtures/scam-bank.txt --fake    # offline keyword classifier
import { parseArgs } from "node:util";
import { YamlDirSource } from "../src/adapters/config/yaml-fs";
import { JevClassifier } from "../src/adapters/jev/classifier";
import { LunaAgent } from "../src/adapters/luna/agent";
import { loadConfig } from "../src/core/config";
import type { Classifier } from "../src/core/ports";
import type { CallEvent } from "../src/core/types";
import { parseTranscript, replay, stubAgent } from "../src/replay/harness";
import { KeywordClassifier } from "../src/replay/keyword-classifier";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    fake: { type: "boolean", default: false },
    luna: { type: "boolean", default: false },
    config: { type: "string", default: "./config" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const file = positionals[0];
if (!file) {
  console.error("usage: bun run replay <transcript.txt> [--fake] [--luna] [--config dir] [--json]");
  process.exit(2);
}

const config = await loadConfig(new YamlDirSource(values.config!), {
  ownerName: process.env.OWNER_NAME,
  agentLanguages: process.env.AGENT_LANGUAGES,
});
const utterances = parseTranscript(await Bun.file(file).text());

let classifier: Classifier;
if (values.fake) classifier = new KeywordClassifier();
else {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY not set (or use --fake)");
  classifier = new JevClassifier({ apiKey });
}

let agent = stubAgent;
if (values.luna) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  agent = new LunaAgent({ apiKey, config: () => config.luna });
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const print = (ev: CallEvent) => {
  if (values.json) return;
  switch (ev.type) {
    case "transcript":
      if (!ev.entry.final) break;
      console.log(`  ${ev.entry.speaker.padEnd(6)} ${ev.entry.text}`);
      break;
    case "classification": {
      const c = ev.classification;
      const extra = Object.entries(c.answers)
        .filter(([q]) => q !== "verdict")
        .map(([q, a]) => ` · ${q}: ${a.choice} ${(a.probabilities[a.choice] ?? 0).toFixed(2)}`)
        .join("");
      console.log(
        `    ↳ jev ${fmt(ev.at)} ${c.verdict} ${c.confidence.toFixed(2)} · urgency ${c.urgency.toFixed(2)}${extra} (${c.latencyMs}ms)`,
      );
      break;
    }
    case "stage":
      console.log(`    ⇒ STAGE ${ev.stage}`);
      break;
    case "luna":
      console.log(`    ⇒ LUNA (${ev.reason}): ${ev.instructions ?? "(no guidance)"}`);
      for (const t of ev.toolCalls) console.log(`       tool ${t.name} ${JSON.stringify(t.args)} → ${t.result}`);
      break;
    case "note":
      console.log(`    ! ${ev.level}: ${ev.message}`);
      break;
  }
};

const res = await replay({ utterances, config, classifier, agent, onEvent: print });
if (values.json) {
  console.log(JSON.stringify({ actions: res.actions, appended: res.appended, events: res.events }, null, 2));
} else {
  console.log(
    `\n${res.jevTicks} Jev ticks · final stage: ${res.finalStage ?? "none"} · Luna calls: ${res.lunaCalls}`,
  );
}
