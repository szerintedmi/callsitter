import { LunaAgent } from "../src/adapters/luna/agent";
import type { AppConfig } from "../src/core/config";
import type { ToolContext } from "../src/core/ports";
import type { TranscriptEntry } from "../src/core/types";
import { parseLines, type LunaCase } from "./cases";
import type { Judge } from "./judge";
import type { Outcome } from "./run";

const dryTools: ToolContext = {
  sendTelegramToOwner: async () => "sent",
  endCall: async () => "ended (dry run)",
};

/** One Luna run on the transcript (tools dry-run), graded by the judge. */
export async function runLunaCase(c: LunaCase, cfg: AppConfig, apiKey: string, judge: Judge): Promise<Outcome> {
  const lines = parseLines(c.transcript);
  const transcript: TranscriptEntry[] = lines.map((l, i) => ({ seq: i + 1, speaker: l.speaker, text: l.text, at: i * 3000, final: true }));
  const luna = new LunaAgent({ apiKey, config: () => cfg.luna });
  const res = await luna.run({
    meta: { callId: "eval", from: "+440000000000", to: "+440000000001", startedAt: Date.now() },
    transcript,
    classification: c.jev ? { ...c.jev, answers: {}, latencyMs: 0 } : null,
    reason: c.reason,
    // As on a phone call with Telegram to the owner set up; tools run dry.
    enabledTools: cfg.luna.tools,
    tools: dryTools,
  });
  const tools = res.toolCalls.map((t) => `tool ${t.name} ${JSON.stringify(t.args)}`).join("\n");
  const produced = [res.instructions ?? "(empty: the agent is on track)", tools].filter(Boolean).join("\n");
  const g = await judge.grade({ conversation: c.transcript.trim(), produced: `Luna's guidance for the agent:\n${produced}`, passIf: c.pass_if });
  return { pass: g.pass, detail: g.reason, log: produced };
}
