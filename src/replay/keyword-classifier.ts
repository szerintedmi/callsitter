import type { Classifier, ClassifierInput } from "../core/ports";
import type { Answer, Classification, Verdict } from "../core/types";

// Offline stand-in for Jev (tests and `replay --fake`). Crude keyword scoring only; it answers
// the verdict, and leaves the other questions unanswered.

const SCAM = [
  /\bbank\b/, /\bhmrc\b/, /\bsafe account\b/, /\bfraud\b/, /\bverify\b/, /\bcard number\b/, /\bpin\b/,
  /\bgift cards?\b/, /\bremote\b/, /\banydesk\b/, /\bteamviewer\b/, /\barrest\b/, /\bwarrant\b/, /\bsuspicious\b/,
  /\bone[- ]time (?:code|passcode)\b/, /\bsecurity code\b/, /\bmicrosoft\b/, /\bvirus\b/,
];
const SPAM = [/\bsurvey\b/, /\boffer\b/, /\bsolar\b/, /\baccident\b/, /\bclaim\b/, /\binvest/, /\bcrypto\b/];
const VERDICTS = ["scam", "spam", "genuine", "unclear"] as const;
const GENUINE = [/\bappointment\b/, /\bdentist\b/, /\bsurgery\b/, /\bmum\b/, /\bdad\b/, /\bmate\b/, /\bcall (?:me|him|her) back\b/, /\bdelivery driver\b/, /\boutside\b/];

export class KeywordClassifier implements Classifier {
  async classify(input: ClassifierInput): Promise<Classification> {
    const text = input.transcript
      .filter((e) => e.speaker === "caller")
      .map((e) => e.text.toLowerCase())
      .join(" ");
    const count = (res: RegExp[]) => res.filter((r) => r.test(text)).length;
    const scam = count(SCAM);
    const spam = count(SPAM);
    const genuine = count(GENUINE);
    const total = scam + spam + genuine;

    let verdict: Classification["verdict"] = "unclear";
    let confidence = 0.3;
    if (total > 0) {
      const top = Math.max(scam, spam, genuine);
      verdict = top === scam ? "scam" : top === spam ? "spam" : "genuine";
      const junk = scam + spam;
      confidence = Math.min(0.95, 0.35 + 0.2 * (verdict === "genuine" ? genuine - junk : junk - genuine));
    }
    confidence = Math.max(0, confidence);
    const answers: Classification["answers"] = {
      verdict: verdictAnswer(verdict, confidence),
    };
    return {
      verdict,
      confidence,
      urgency: verdict === "genuine" ? 0.7 : 0.1,
      answers,
      latencyMs: 0,
    };
  }
}

/**
 * A verdict answer with this confidence. The rest of the probability goes to the other verdicts,
 * but not to the other junk one: for scam/spam the confidence is P(scam) + P(spam), as with Jev.
 */
export function verdictAnswer(verdict: Verdict, confidence: number): Answer {
  const junk = (v: string) => v === "scam" || v === "spam";
  const others = VERDICTS.filter((v) => v !== verdict && !(junk(v) && junk(verdict)));
  return {
    choice: verdict,
    probabilities: Object.fromEntries(
      VERDICTS.map((v) => [v, v === verdict ? confidence : others.includes(v) ? (1 - confidence) / others.length : 0]),
    ),
  };
}
