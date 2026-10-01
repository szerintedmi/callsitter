import { describe, expect, test } from "bun:test";
import { checkFlow, ConfigError, parseConfig } from "../src/core/config";
import { decide, holds, type FlowState } from "../src/core/flow";
import { cls, loadConfigWithLuna } from "./helpers";

// The repo's config/call-flow.yaml, so these tests pin the behaviour it describes.
const cfg = await loadConfigWithLuna();
const message = (stage: string) => cfg.flow.rules.find((r) => r.stage === stage)!.then!.tell_live!;

const state = (p: Partial<FlowState> = {}): FlowState => ({
  elapsedMs: 10_000,
  stage: null,
  lunaCalls: 0,
  lastLunaAt: null,
  lastLunaCallerRev: null,
  callerRev: 5,
  ...p,
});

const stageOf = (a: ReturnType<typeof decide>) => (a.kind === "tell_live" ? a.stage : a.kind);

describe("call flow (config/call-flow.yaml)", () => {
  test("confident scam → waste time", () => {
    expect(decide(cls(), state(), cfg)).toEqual({ kind: "tell_live", stage: "waste_time", message: message("waste_time") });
  });

  test("confident spam → a polite no, not time wasting; then nothing more", () => {
    expect(stageOf(decide(cls({ verdict: "spam" }), state(), cfg))).toBe("decline_spam");
    expect(decide(cls({ verdict: "spam" }), state({ stage: "decline_spam" }), cfg)).toMatchObject({ kind: "none" });
  });

  test("scam below 0.80 or spam below 0.85 switches nothing", () => {
    expect(stageOf(decide(cls({ verdict: "scam", confidence: 0.75 }), state(), cfg))).not.toBe("waste_time");
    expect(stageOf(decide(cls({ verdict: "spam", confidence: 0.8 }), state(), cfg))).not.toBe("decline_spam");
  });

  test("the text isn't re-sent while the call stays in its stage", () => {
    expect(decide(cls(), state({ stage: "waste_time" }), cfg)).toEqual({ kind: "none", reason: "waste time: unchanged" });
  });

  test("unclear verdict → nothing (the Live prompt asks who is calling)", () => {
    const u = cls({ verdict: "unclear", confidence: 0.6 });
    expect(decide(u, state(), cfg)).toEqual({ kind: "none", reason: "still unclear" });
    expect(decide(u, state({ stage: "waste_time" }), cfg)).toEqual({ kind: "none", reason: "still unclear" });
    // Low confidence doesn't send an unclear call to Luna: there's nothing to go on yet.
    expect(decide(cls({ verdict: "unclear", confidence: 0.2 }), state(), cfg)).toEqual({ kind: "none", reason: "still unclear" });
  });

  test("a call past a jailbreak attempt that turns out to be a scam switches to time-wasting", () => {
    expect(stageOf(decide(cls(), state({ stage: "resist_manipulation" }), cfg))).toBe("waste_time");
  });

  test("a call with everything it needs → wrap_up, then no more steering (no Luna)", () => {
    const done = cls({ verdict: "genuine", confidence: 0.9, done: 0.8 });
    expect(stageOf(decide(done, state(), cfg))).toBe("wrap_up");
    expect(decide(done, state({ stage: "wrap_up" }), cfg)).toEqual({ kind: "none", reason: "keep wrapping up" });
    expect(stageOf(decide(cls({ verdict: "genuine", confidence: 0.9, done: 0.5 }), state(), cfg))).toBe("genuine");
  });

  test("a jailbreak attempt → resist_manipulation, once, whatever the verdict", () => {
    // Only when Jev is fairly sure: "What do you think?" at 0.70 deflected a genuine caller.
    expect(decide(cls({ verdict: "unclear", confidence: 0.9, manipulation: 0.7 }), state(), cfg).kind).toBe("none");
    const jb = cls({ verdict: "unclear", confidence: 0.9, manipulation: 0.8 });
    expect(stageOf(decide(jb, state(), cfg))).toBe("resist_manipulation");
    expect(decide(jb, state({ stage: "resist_manipulation" }), cfg)).toEqual({ kind: "none", reason: "resist manipulation: unchanged" });
    const back = cls({ verdict: "unclear", confidence: 0.9, manipulation: 0.1 });
    expect(decide(back, state({ stage: "resist_manipulation" }), cfg)).toEqual({ kind: "none", reason: "still unclear" });
    // Jev calls most jailbreaks scams; the time-wasting role alone doesn't stop the agent complying.
    expect(stageOf(decide(cls({ manipulation: 0.9 }), state({ stage: "waste_time" }), cfg))).toBe("resist_manipulation");
  });

  test("scam/spam calls never wrap up; they keep wasting time", () => {
    expect(stageOf(decide(cls({ done: 0.99 }), state(), cfg))).toBe("waste_time");
  });

  test("scam between thresholds → nothing", () => {
    expect(decide(cls({ confidence: 0.6 }), state(), cfg)).toEqual({ kind: "none", reason: "no rule matched" });
  });

  test("confident genuine → Live is told once (no Luna): it takes the message, the summary passes it on", () => {
    const genuine = cls({ verdict: "genuine", confidence: 0.8 });
    expect(decide(genuine, state(), cfg)).toMatchObject({ kind: "tell_live", stage: "genuine", message: { as: "thinking" } });
    expect(decide(genuine, state({ stage: "genuine" }), cfg)).toEqual({ kind: "none", reason: "no rule matched" });
    // A call handled as a scam stays one.
    expect(decide(genuine, state({ stage: "waste_time" }), cfg)).toEqual({ kind: "none", reason: "no rule matched" });
    expect(decide(cls({ verdict: "genuine", confidence: 0.6 }), state(), cfg)).toEqual({ kind: "none", reason: "no rule matched" });
  });

  test("low confidence (not unclear) → Luna judges, her reply sent as a SUPERVISOR line", () => {
    expect(decide(cls({ confidence: 0.2 }), state(), cfg)).toEqual({
      kind: "luna",
      reason: "low confidence",
      stage: "low_confidence",
      message: message("low_confidence"),
    });
    expect(message("low_confidence").text).toContain("{luna_response}");
  });

  test("urgency alone doesn't steer: an urgent genuine call is still told it's genuine", () => {
    const urgent = (p: Parameters<typeof cls>[0]) => cls({ urgency: 0.85, ...p });
    // The neighbour with a parcel: genuine 0.64 at first (nothing yet), then confidently genuine.
    expect(decide(urgent({ verdict: "genuine", confidence: 0.64 }), state(), cfg)).toEqual({ kind: "none", reason: "no rule matched" });
    expect(stageOf(decide(urgent({ verdict: "genuine", confidence: 0.9 }), state(), cfg))).toBe("genuine");
    expect(stageOf(decide(urgent({ verdict: "genuine", confidence: 0.9 }), state({ stage: "low_confidence" }), cfg))).toBe("genuine");
    expect(decide(urgent({ verdict: "unclear", confidence: 0.7 }), state(), cfg)).toEqual({ kind: "none", reason: "still unclear" });
    // A confident scam wastes time, urgent or not.
    expect(stageOf(decide(urgent({}), state(), cfg))).toBe("waste_time");
  });

  test("Luna is asked again while the call stays in her stage", () => {
    expect(decide(cls({ verdict: "genuine", confidence: 0.3 }), state({ stage: "low_confidence" }), cfg).kind).toBe("luna");
  });

  test("sent when the agent is idle, except resist_manipulation and waste_time (sent at once)", () => {
    const how = (m: { as: string; send: string; max_hold_ms: number | null }) => [m.as, m.send, m.max_hold_ms];
    // A role to keep is thinking; what the agent should say now is commentary.
    expect(how(message("waste_time"))).toEqual(["thinking", "now", 8000]);
    for (const stage of ["wrap_up", "low_confidence"]) {
      expect(how(message(stage))).toEqual(["commentary", "when_agent_idle", 8000]);
    }
    expect(how(cfg.flow.silence.tell_live)).toEqual(["commentary", "when_agent_idle", 8000]);
    expect(how(cfg.flow.when_live_asks_for_help.fallback)).toEqual(["commentary", "when_agent_idle", 8000]);
    expect(how(message("resist_manipulation")).slice(0, 2)).toEqual(["commentary", "now"]);
  });

  test("Luna limit, cooldown and no-new-speech guards", () => {
    const g = cls({ verdict: "genuine", confidence: 0.3 });
    const l = cfg.luna.limits;
    expect(decide(g, state({ lunaCalls: l.max_calls }), cfg)).toMatchObject({ kind: "none", lunaSkipped: true });
    // In cooldown: deferred until it ends, so the new speech still gets to Luna.
    expect(decide(g, state({ lastLunaAt: 5_000, lastLunaCallerRev: 1 }), cfg)).toEqual({
      kind: "luna_deferred",
      reason: "low confidence",
      stage: "low_confidence",
      message: message("low_confidence"),
      atMs: 5_000 + l.cooldown_ms,
    });
    expect(decide(g, state({ lastLunaAt: 0, lastLunaCallerRev: 5 }), cfg).kind).toBe("none");
    expect(decide(g, state({ elapsedMs: 30_000, lastLunaAt: 0, lastLunaCallerRev: 4 }), cfg).kind).toBe("luna");
  });

  test('an explicit end of call ("just hang up") → end call, any verdict', () => {
    expect(decide(cls({ confidence: 0.98, ended: 0.9 }), state({ stage: "waste_time" }), cfg)).toEqual({
      kind: "end_call",
      reason: "call flow: call over",
    });
    expect(decide(cls({ verdict: "genuine", confidence: 0.3, ended: 0.6 }), state(), cfg).kind).toBe("luna");
  });

  test("max call length → end call, regardless of verdict", () => {
    const s = state({ elapsedMs: cfg.flow.timing.max_call_seconds * 1000 });
    expect(decide(cls(), s, cfg)).toEqual({ kind: "end_call", reason: "max call length reached" });
  });
});

describe("call flow engine", () => {
  const a = { choice: "scam", probabilities: { scam: 0.45, spam: 0.35, genuine: 0.2 } };

  test("conditions: chosen answer, summed probabilities, unsure", () => {
    expect(holds("scam", a)).toBe(true);
    expect(holds(["spam", "genuine"], a)).toBe(false);
    expect(holds({ is: ["scam", "spam"], min: 0.75 }, a)).toBe(true);
    expect(holds({ is: "scam", min: 0.5 }, a)).toBe(false);
    expect(holds({ is: "scam" }, a)).toBe(true);
    expect(holds({ unsure: 0.5 }, a)).toBe(true);
    expect(holds({ unsure: 0.4 }, a)).toBe(false);
    expect(holds("scam", undefined)).toBe(false); // question not answered
  });

  test("urgency conditions check Jev's urgency score", () => {
    const f = flow([
      { stage: "urgent", when: { urgency: { min: 0.8 } }, then: { tell_live: { as: "thinking", text: "a" } } },
      { stage: "rest" },
    ]);
    expect(stageOf(decide(cls({ urgency: 0.8 }), state(), { flow: f, luna: cfg.luna }))).toBe("urgent");
    expect(decide(cls({ urgency: 0.7 }), state(), { flow: f, luna: cfg.luna })).toEqual({ kind: "none", reason: "rest" });
  });

  const flow = (rules: unknown[]) => parseConfig("flow", { rules });

  test("first matching rule wins; a rule without then stops the flow", () => {
    const f = flow([
      { stage: "quiet", when: { verdict: "genuine" } },
      { stage: "fallback", then: { tell_live: { as: "instructions", text: "hi" } } },
    ]);
    expect(decide(cls({ verdict: "genuine" }), state(), { flow: f, luna: cfg.luna })).toEqual({ kind: "none", reason: "quiet" });
    expect(stageOf(decide(cls(), state(), { flow: f, luna: cfg.luna }))).toBe("fallback");
  });

  test("stage conditions check the stage the last tell_live entered", () => {
    const f = flow([
      { stage: "first", when: { stage: "none" }, then: { tell_live: { as: "thinking", text: "a" } } },
      { stage: "after", when: { stage: "first" }, then: { hang_up: true } },
    ]);
    expect(stageOf(decide(cls(), state(), { flow: f, luna: cfg.luna }))).toBe("first");
    expect(decide(cls(), state({ stage: "first" }), { flow: f, luna: cfg.luna }).kind).toBe("end_call");
  });

  test("defaults.tell_live applies to every tell_live that doesn't set its own", () => {
    const f = parseConfig("flow", {
      defaults: { tell_live: { send: "now" } },
      rules: [
        { stage: "a", then: { tell_live: { as: "instructions", text: "a" } } },
        { stage: "b", then: { tell_live: { as: "instructions", text: "b", send: "when_agent_idle", max_hold_ms: null } } },
      ],
    });
    expect(f.rules[0]!.then!.tell_live).toEqual({ as: "instructions", text: "a", send: "now", max_hold_ms: 8000 });
    expect(f.rules[1]!.then!.tell_live).toEqual({ as: "instructions", text: "b", send: "when_agent_idle", max_hold_ms: null });
    expect(f.silence.tell_live.send).toBe("now");
    expect(f.when_live_asks_for_help.tell_live).toEqual({ as: "commentary", text: "SUPERVISOR: {luna_response}", send: "now", max_hold_ms: 8000 });
    expect("defaults" in f).toBe(false);
  });

  test("a Luna rule without tell_live asks Luna but tells Live nothing and enters no stage", () => {
    const f = flow([{ stage: "tools_only", then: { ask_luna: true } }]);
    expect(decide(cls(), state(), { flow: f, luna: cfg.luna })).toEqual({ kind: "luna", reason: "tools only", stage: "tools_only" });
    expect(() => flow([{ stage: "x", then: { ask_luna: true } }, { stage: "y", when: { stage: "x" } }])).toThrow(
      /x is not none or a stage with tell_live/,
    );
  });

  test("rejects malformed rules with the stage in the message", () => {
    const say = { as: "instructions", text: "a" };
    expect(() => flow([{ stage: "x", then: { tell_live: say, hang_up: true } }])).toThrow(
      /rules\[x\]\.then: hang_up can't be combined with tell_live or ask_luna/,
    );
    expect(() => flow([{ stage: "x", then: {} }])).toThrow(/rules\[x\]\.then: needs tell_live, ask_luna or hang_up/);
    // Luna's reply has to go somewhere in the text, and only Luna rules have one.
    expect(() => flow([{ stage: "x", then: { ask_luna: true, tell_live: say } }])).toThrow(
      /rules\[x\]\.then\.tell_live\.text: with ask_luna, the text needs \{luna_response\}/,
    );
    expect(() => flow([{ stage: "x", then: { tell_live: { as: "instructions", text: "{luna_response}" } } }])).toThrow(
      /rules\[x\]\.then\.tell_live\.text: \{luna_response\} needs ask_luna/,
    );
    expect(() => flow([{ stage: "x", then: { tell_live: { ...say, send: "now", max_hold_ms: 100 } } }])).toThrow(
      /rules\[x\]\.then\.tell_live\.max_hold_ms: max_hold_ms only applies to send: when_agent_idle/,
    );
    expect(() => flow([{ stage: "x", then: { tell_live: { ...say, send: "later" } } }])).toThrow(/rules\[x\]\.then\.tell_live\.send/);
    expect(() =>
      parseConfig("flow", { rules: [{ stage: "x" }], silence: { tell_live: { as: "instructions", text: "{luna_response}" } } }),
    ).toThrow(/silence\.tell_live\.text: \{luna_response\} is only filled in with ask_luna/);
    // Every tell_live says how it reaches Live.
    expect(() => flow([{ stage: "x", then: { tell_live: "a" } }])).toThrow(/rules\[x\]\.then\.tell_live/);
    expect(() => flow([{ stage: "x", then: { tell_live: { text: "a" } } }])).toThrow(/rules\[x\]\.then\.tell_live\.as/);
    expect(() => flow([{ stage: "x", then: { tell_live: { as: "speech", text: "a" } } }])).toThrow(/rules\[x\]\.then\.tell_live\.as/);
    expect(() => flow([{ stage: "x", then: { ...say, on_silence: "hang_up" } }])).toThrow(/rules\[x\]\.then/); // now silence.hang_up_in
    expect(() => parseConfig("flow", { rules: [{ stage: "x" }], silence: { hang_up_in: ["x"] } })).toThrow(
      /silence\.hang_up_in\.0: x is not a stage with tell_live/,
    );
    expect(() => flow([{ stage: "x", then: { hang_up: true, when_live_asks_for_help: "a" } }])).toThrow(
      /rules\[x\]\.then\.when_live_asks_for_help: when_live_asks_for_help needs tell_live/,
    );
    expect(() => flow([{ stage: "x", when: { stage: "y" } }])).toThrow(/y is not none or a stage with tell_live/);
    expect(() => flow([{ stage: "x" }, { stage: "x" }])).toThrow(/duplicate stage x/);
    expect(() => flow([{ stage: "x", when: { verdict: { min: 0.5 } } }])).toThrow(/rules\[x\]\.when\.verdict/);
    expect(() => flow([{ id: "x", then: { hang_up: true } }])).toThrow(ConfigError); // rules are named by stage
  });

  test("checks questions and answers against jev.yaml", () => {
    const check = (rules: unknown[]) => () => checkFlow(flow(rules), cfg.jev);
    expect(check([{ stage: "x", when: { verdikt: "scam" } }])).toThrow(/no Choice question verdikt/);
    expect(check([{ stage: "x", when: { verdict: { is: ["scam", "fraud"], min: 0.5 } } }])).toThrow(/fraud is not an answer/);
    expect(check([{ stage: "x", when: { manipulation: "attempt" } }])).not.toThrow();
    expect(check([{ stage: "x", when: { topic: "abuse" } }])).toThrow(/no Choice question topic/); // dropped
    expect(check([{ stage: "x", when: { category: "tech_support" } }])).toThrow(/no Choice question category/); // dropped
    // Urgency is a score, not a Choice.
    expect(() => flow([{ stage: "x", when: { urgency: "high" } }])).toThrow(/rules\[x\]\.when\.urgency: expected \{ min/);
  });
});
