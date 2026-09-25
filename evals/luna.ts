import { LunaAgent } from "../src/adapters/luna/agent";
import type { AppConfig } from "../src/core/config";
import type { ToolContext } from "../src/core/ports";
import type { TranscriptEntry } from "../src/core/types";
import { parseLines, type LunaCase } from "./cases";
import type { Judge } from "./judge";
import type { Outcome } from "./run";

const dryTools: ToolContext = {
  sendSmsToOwner: async () => "sent (dry run)",
  endCall: async () => "ended (dry run)",
  takeMessage: async () => "recorded",
};

/** One Luna run on the transcript (tools dry-run), graded by the judge. */
export async function runLunaCase(c: LunaCase, cfg: AppConfig, apiKey: string, judge: Judge): Promise<Outcome> {
  const lines = parseLines(c.transcript);
  const transcript: TranscriptEntry[] = lines.map((l, i) => ({ seq: i + 1, speaker: l.speaker, text: l.text, at: i * 3000, final: true }));
  const luna = new LunaAgent({ apiKey, config: () => cfg.luna });
  const res = await luna.run({
    meta: { callId: "eval", from: "+440000000000", to: "+440000000001", startedAt: Date.now() },
    transcript,
    classification: null,
    reason: c.reason,
    enabledTools: cfg.luna.tools.filter((t) => t !== "send_sms_to_owner"),
    tools: dryTools,
  });
  const tools = res.toolCalls.map((t) => `tool ${t.name} ${JSON.stringify(t.args)}`).join("\n");
  const produced = [res.instructions ?? "(empty: the agent is on track)", tools].filter(Boolean).join("\n");
  const g = await judge.grade({ conversation: c.transcript.trim(), produced: `Luna's guidance for the agent:\n${produced}`, passIf: c.pass_if });
  return { pass: g.pass, detail: g.reason, log: produced };
}
