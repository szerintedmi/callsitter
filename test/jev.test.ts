import { describe, expect, test } from "bun:test";
import { buildRequest, toClassification } from "../src/adapters/jev/classifier";
import { loadRepoConfig } from "./helpers";

describe("Jev adapter", () => {
  test("builds one systemOne request with every jev.yaml question", async () => {
    const cfg = await loadRepoConfig();
    const req = buildRequest({
      meta: { callId: "c", from: "+441234", to: "+445678", startedAt: 0 },
      transcript: [
        { seq: 1, speaker: "agent", text: "Hello?", at: 0, final: true },
        { seq: 2, speaker: "caller", text: "This is your bank.", at: 1000, final: false },
      ],
      config: cfg.jev,
    });
    const q = req.questions as Record<string, { type: string; criteria: object }>;
    expect(req.model).toBe("jev-latest");
    expect(req.state.transcript).toBe("agent: Hello?\ncaller: This is your bank.");
    expect(Object.keys(req.state)).toEqual(["context", "caller_number", "transcript"]); // no stage: it would bias the verdict
    expect(Object.keys(q)).toEqual(["verdict", "urgency", "done", "ended", "manipulation", "owner_update"]);
    expect(q.verdict).toMatchObject({ type: "choice" });
    expect(Object.keys(q.verdict!.criteria)).toEqual(["scam", "spam", "genuine", "unclear"]);
    expect(Object.keys(q.manipulation!.criteria)).toEqual(["attempt", "none"]);
    expect(q.urgency).toMatchObject({ type: "score" });
    expect(q.urgency!.criteria).toHaveLength(cfg.jev.questions.urgency.levels.length);
  });

  test("the owner's last status update is marked in the transcript", async () => {
    const cfg = await loadRepoConfig();
    const transcript = [
      { seq: 1, speaker: "caller" as const, text: "It's Sarah.", at: 0, final: true },
      { seq: 2, speaker: "agent" as const, text: "Hi Sarah.", at: 1000, final: true },
      { seq: 3, speaker: "caller" as const, text: "Is he free Tuesday?", at: 2000, final: true },
    ];
    const meta = { callId: "c", from: "+441", to: "+442", startedAt: 0 };
    const req = buildRequest({ meta, transcript, config: cfg.jev, ownerUpdatedThrough: 2 });
    expect(req.state.transcript).toBe(`caller: It's Sarah.\nagent: Hi Sarah.\n${cfg.jev.owner_update_marker}\ncaller: Is he free Tuesday?`);
    expect(buildRequest({ meta, transcript, config: cfg.jev, ownerUpdatedThrough: 3 }).state.transcript.endsWith(cfg.jev.owner_update_marker)).toBe(true);
    expect(buildRequest({ meta, transcript, config: cfg.jev }).state.transcript).not.toContain(cfg.jev.owner_update_marker);
  });

  test("maps answers: scam+spam probability is the junk confidence; urgency normalised", () => {
    const c = toClassification(
      {
        verdict: { choice: "scam", probabilities: { scam: 0.5, spam: 0.35, genuine: 0.15 } },
        urgency: { score: 1.5 },
      },
      4,
      120,
    );
    expect(c.verdict).toBe("scam");
    expect(c.confidence).toBeCloseTo(0.85);
    expect(c.urgency).toBeCloseTo(0.5);
    expect(c.latencyMs).toBe(120);
  });

  test("keeps every Choice answer for the call flow, but not the urgency score", () => {
    const c = toClassification(
      {
        verdict: { choice: "unclear", probabilities: { unclear: 0.9 } },
        urgency: { score: 0 },
        manipulation: { choice: "attempt", probabilities: { attempt: 0.6, none: 0.4 } },
      },
      4,
      50,
    );
    expect(Object.keys(c.answers)).toEqual(["verdict", "manipulation"]);
    expect(c.answers.manipulation).toEqual({ choice: "attempt", probabilities: { attempt: 0.6, none: 0.4 } });
  });

  test("genuine confidence is the genuine probability", () => {
    const c = toClassification(
      {
        verdict: { choice: "genuine", probabilities: { scam: 0.1, spam: 0.1, genuine: 0.8 } },
        urgency: { score: 3 },
      },
      4,
      50,
    );
    expect(c.verdict).toBe("genuine");
    expect(c.confidence).toBeCloseTo(0.8);
    expect(c.urgency).toBe(1);
  });

  test("unclear keeps its own probability as confidence", () => {
    const c = toClassification(
      {
        verdict: { choice: "unclear", probabilities: { scam: 0.2, spam: 0.1, genuine: 0.1, unclear: 0.6 } },
        urgency: { score: 0 },
      },
      4,
      50,
    );
    expect(c.verdict).toBe("unclear");
    expect(c.confidence).toBeCloseTo(0.6);
  });
});
