import { TypeSafeClient, choice, score } from "@typesafe-ai/sdk";
import type { Classifier, ClassifierInput } from "../../core/ports";
import type { Answer, Classification, TranscriptEntry, Verdict } from "../../core/types";

// TypeSafe Jev adapter. One systemOne call per tick with all questions
// (https://docs.typesafe.ai/api.md). Retries are disabled: a retried answer would be stale.

export function renderTranscript(entries: readonly TranscriptEntry[]): string {
  return entries.map((e) => `${e.speaker}: ${e.text}`).join("\n");
}

export function buildRequest(input: ClassifierInput) {
  const { verdict, urgency, ...extra } = input.config.questions;
  const [first, second, ...rest] = urgency.levels;

  return {
    model: input.config.model,
    // No call-flow stage here: every question sees the whole state, and a time-wasting
    // stage in it hints "scam" to the verdict question (a self-reinforcing loop).
    state: {
      context: input.config.context,
      caller_number: input.meta.from,
      transcript: renderTranscript(input.transcript),
    },
    questions: {
      verdict: choice(verdict.prompt, { ...verdict.labels }),
      urgency: score(urgency.prompt, [first!, second!, ...rest]),
      ...Object.fromEntries(Object.entries(extra).map(([name, q]) => [name, choice(q.prompt, { ...q.labels })])),
    },
  };
}

type ChoiceAnswer = { choice: string; probabilities: Record<string, number> };
type Answers = { urgency: { score: number } } & Record<string, ChoiceAnswer | { score: number }>;

/**
 * Maps Jev answers to a Classification. Confidence is the probability mass of the chosen
 * verdict family: scam and spam are both junk, so their probabilities add up. `unclear` (not
 * enough context yet) keeps its own probability. Every Choice answer is kept for the call flow.
 */
export function toClassification(a: Answers, urgencyLevels: number, latencyMs: number, raw?: unknown): Classification {
  const answers: Record<string, Answer> = {};
  for (const [name, ans] of Object.entries(a)) {
    if ("choice" in ans) answers[name] = { choice: ans.choice, probabilities: { ...ans.probabilities } };
  }
  const p = answers.verdict?.probabilities ?? {};
  const pJunk = (p.scam ?? 0) + (p.spam ?? 0);
  const choice = answers.verdict?.choice;
  const verdict: Verdict = choice === "genuine" || choice === "spam" || choice === "unclear" ? choice : "scam";
  const confidence = verdict === "genuine" || verdict === "unclear" ? (p[verdict] ?? 0) : pJunk;
  return {
    verdict,
    confidence: clamp01(confidence),
    urgency: clamp01(a.urgency.score / Math.max(1, urgencyLevels - 1)),
    answers,
    latencyMs,
    raw,
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export class JevClassifier implements Classifier {
  private client: TypeSafeClient;

  constructor(opts: { apiKey: string; baseURL?: string; timeoutMs?: number }) {
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 1500,
      retry: { maxRetries: 0 },
    });
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    const started = performance.now();
    const res = await this.client.systemOne(buildRequest(input), {
      signal: input.signal,
      timeout: input.config.timeout_ms,
    });
    const latency = Math.round(performance.now() - started);
    return toClassification(res.answers as unknown as Answers, input.config.questions.urgency.levels.length, latency, {
      model: res.model,
      usage: res.usage,
      answers: res.answers,
    });
  }
}
