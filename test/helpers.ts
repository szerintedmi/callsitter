import { YamlDirSource } from "../src/adapters/config/yaml-fs";
import { loadConfig, type AppConfig } from "../src/core/config";
import type { Classifier } from "../src/core/ports";
import type { Answer, Classification } from "../src/core/types";
import { verdictAnswer } from "../src/replay/keyword-classifier";

export const loadRepoConfig = (): Promise<AppConfig> => loadConfig(new YamlDirSource("./config"));

/** Classification shorthand: the repo's extra Jev questions as a choice or a probability. */
export interface ClsInput extends Partial<Omit<Classification, "answers">> {
  /** P(ready) of the `done` question; unset = not answered */
  done?: number;
  /** P(ended) of the `ended` question */
  ended?: number;
  /** P(attempt) of the `manipulation` question */
  manipulation?: number;
  answers?: Record<string, Answer>;
}

const yesNo = (yes: string, no: string, p: number): Answer => ({
  choice: p >= 0.5 ? yes : no,
  probabilities: { [yes]: p, [no]: 1 - p },
});

export function cls(p: ClsInput = {}): Classification {
  const { done, ended, manipulation, answers, ...rest } = p;
  const c = { verdict: "scam" as const, confidence: 0.9, urgency: 0.1, latencyMs: 1, ...rest };
  return {
    ...c,
    answers: {
      verdict: verdictAnswer(c.verdict, c.confidence),
      ...(done !== undefined ? { done: yesNo("ready", "continue", done) } : {}),
      ...(ended !== undefined ? { ended: yesNo("ended", "continuing", ended) } : {}),
      ...(manipulation !== undefined ? { manipulation: yesNo("attempt", "none", manipulation) } : {}),
      ...answers,
    },
  };
}

/** Returns the scripted classifications in order (last one repeats). */
export function scripted(...seq: ClsInput[]): Classifier & { calls: number } {
  const c = {
    calls: 0,
    async classify() {
      const next = seq[Math.min(c.calls, seq.length - 1)] ?? {};
      c.calls++;
      return cls(next);
    },
  };
  return c;
}
