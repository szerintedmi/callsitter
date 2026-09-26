import type { AppConfig, Condition, Rule, TellLive } from "./config";
import type { Answer, Classification } from "./types";

// The call flow (config/call-flow.yaml): Jev's answers + call state → one action. Pure.

export interface FlowState {
  /** ms since call start */
  elapsedMs: number;
  /** the stage of the rule that last told Live something, or null */
  stage: string | null;
  lunaCalls: number;
  /** ms since call start of the last Luna call, or null */
  lastLunaAt: number | null;
  /** the transcript's callerRev at the last Luna call; Luna is only re-invoked when the caller said more */
  lastLunaCallerRev: number | null;
  callerRev: number;
}

export type FlowAction =
  /** lunaSkipped: a rule asked for Luna but her limits don't allow a call */
  | { kind: "none"; reason: string; lunaSkipped?: true }
  /** append `message` to the Live session; the call enters `stage` */
  | { kind: "tell_live"; stage: string; message: TellLive }
  /** ask Luna; `message` (if any) sends her reply, and the call enters `stage` */
  | { kind: "luna"; reason: string; stage: string; message?: TellLive }
  /** Luna is wanted but in cooldown: call it at `atMs` (ms since call start) unless overtaken */
  | { kind: "luna_deferred"; reason: string; stage: string; message?: TellLive; atMs: number }
  | { kind: "end_call"; reason: string };

/** The first rule whose `when` holds, or null. */
export function matchRule(c: Classification, stage: string | null, rules: readonly Rule[]): Rule | null {
  return (
    rules.find(
      (r) =>
        (!r.inStage || r.inStage.includes(stage ?? "none")) &&
        (r.minUrgency === undefined || c.urgency >= r.minUrgency) &&
        Object.entries(r.when).every(([q, cond]) => holds(cond, c.answers[q])),
    ) ?? null
  );
}

export function holds(cond: Condition, a: Answer | undefined): boolean {
  if (!a) return false;
  if (typeof cond === "string") return a.choice === cond;
  if (Array.isArray(cond)) return cond.includes(a.choice);
  if ("unsure" in cond) return (a.probabilities[a.choice] ?? 0) < cond.unsure;
  const labels = typeof cond.is === "string" ? [cond.is] : cond.is;
  if (cond.min === undefined) return labels.includes(a.choice);
  return labels.reduce((sum, l) => sum + (a.probabilities[l] ?? 0), 0) >= cond.min;
}

export function decide(c: Classification, s: FlowState, cfg: Pick<AppConfig, "flow" | "luna">): FlowAction {
  if (s.elapsedMs >= cfg.flow.timing.max_call_seconds * 1000) return { kind: "end_call", reason: "max call length reached" };

  const rule = matchRule(c, s.stage, cfg.flow.rules);
  if (!rule) return { kind: "none", reason: "no rule matched" };
  const reason = rule.stage.replaceAll("_", " ");
  const then = rule.then;
  if (!then) return { kind: "none", reason };
  // The call's end reason: say it was the call flow, as Luna's hang-ups say "Luna: …".
  if (then.hang_up) return { kind: "end_call", reason: `call flow: ${reason}` };
  if (!then.ask_luna) {
    if (rule.stage === s.stage) return { kind: "none", reason: `${reason}: unchanged` };
    return { kind: "tell_live", stage: rule.stage, message: then.tell_live! };
  }

  // Luna is asked again while the call stays in this stage, as long as the caller said more.
  const luna = { reason, stage: rule.stage, ...(then.tell_live ? { message: then.tell_live } : {}) };
  const l = cfg.luna.limits;
  if (s.lunaCalls >= l.max_calls) return { kind: "none", reason: `${reason}; Luna limit reached`, lunaSkipped: true };
  if (s.lastLunaCallerRev !== null && s.callerRev <= s.lastLunaCallerRev) {
    return { kind: "none", reason: `${reason}; no new speech since last Luna call`, lunaSkipped: true };
  }
  if (s.lastLunaAt !== null && s.elapsedMs - s.lastLunaAt < l.cooldown_ms) {
    return { kind: "luna_deferred", ...luna, atMs: s.lastLunaAt + l.cooldown_ms };
  }
  return { kind: "luna", ...luna };
}
