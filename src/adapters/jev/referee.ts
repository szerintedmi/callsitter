import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import type { Referee, RefereeInput } from "../../core/ports";
import { renderTranscript } from "./classifier";

// The public games' referee on TypeSafe Jev (games.yaml referee): one systemOne call with the
// game's question, the goal in the state. Separate from the call's own Jev (JevClassifier).

/** The goal as the referee reads it: its name and what the question looks for. */
export function describeGoal(goal: RefereeInput["goal"]): string {
  return "message" in goal ? `${goal.name}. Message: ${goal.message}.` : `${goal.name}. Start: ${goal.start}.`;
}

export function buildRefereeRequest(i: RefereeInput) {
  const questions: Record<string, { prompt: string; yes: string; no: string }> = i.config[i.game];
  return {
    model: i.config.model,
    state: { context: i.config.context, goal: describeGoal(i.goal), transcript: renderTranscript(i.transcript) },
    questions: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, choice(q.prompt, { yes: q.yes, no: q.no })])),
  };
}

export class JevReferee implements Referee {
  private client: TypeSafeClient;

  constructor(opts: { apiKey: string; baseURL?: string }) {
    this.client = new TypeSafeClient({ apiKey: opts.apiKey, baseURL: opts.baseURL, retry: { maxRetries: 0 } });
  }

  async judge(input: RefereeInput): Promise<Record<string, number>> {
    const res = await this.client.systemOne(buildRefereeRequest(input), { signal: input.signal, timeout: input.config.timeout_ms });
    const answers = res.answers as unknown as Record<string, { probabilities?: Record<string, number> }>;
    return Object.fromEntries(Object.entries(answers).map(([name, a]) => [name, a.probabilities?.yes ?? 0]));
  }
}
