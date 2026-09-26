import type { AppConfig, TellLive } from "../core/config";
import { MemoryEventBus } from "../core/event-bus";
import { Orchestrator } from "../core/orchestrator";
import type { FlowAction } from "../core/flow";
import type { Agent, Classifier } from "../core/ports";
import type { CallEvent, Speaker } from "../core/types";

// Feeds a saved transcript through Jev → call flow (→ Luna) without a phone call.
// Luna tools run in dry-run mode: nothing is sent and no call is ended.

export interface Utterance {
  speaker: Speaker;
  text: string;
}

/** Parses "caller: …" / "agent: …" lines; blank lines and # comments are ignored. */
export function parseTranscript(text: string): Utterance[] {
  const out: Utterance[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const m = l.match(/^(caller|agent)\s*:\s*(.+)$/i);
    if (!m) throw new Error(`bad transcript line (expected "caller: …" or "agent: …"): ${l}`);
    out.push({ speaker: m[1]!.toLowerCase() as Speaker, text: m[2]!.trim() });
  }
  return out;
}

/** Luna stand-in when no API key is available. */
export const stubAgent: Agent = {
  async run(input) {
    return { instructions: `(stub Luna: consulted because ${input.reason})`, toolCalls: [] };
  },
  async summarize() {
    return { text: "(stub summary)" };
  },
};

export interface ReplayResult {
  actions: FlowAction[];
  appended: TellLive[];
  events: CallEvent[];
  finalStage: string | null;
  lunaCalls: number;
  jevTicks: number;
}

export async function replay(opts: {
  utterances: Utterance[];
  config: AppConfig;
  classifier: Classifier;
  agent?: Agent;
  onEvent?: (ev: CallEvent) => void;
}): Promise<ReplayResult> {
  // Wall clock, so {current_time} in the prompts is now; event times stay relative to the start.
  let now = Date.now();
  const startedAt = now;
  const bus = new MemoryEventBus();
  const events: CallEvent[] = [];
  bus.subscribe((ev) => {
    events.push(ev);
    opts.onEvent?.(ev);
  });
  const appended: TellLive[] = [];
  const orch = new Orchestrator({
    meta: { callId: "replay", from: "+440000000000", to: "+440000000001", startedAt },
    config: () => opts.config,
    classifier: opts.classifier,
    agent: opts.agent ?? stubAgent,
    bus,
    steer: {
      tellLive: (s) => void appended.push(s.message),
      hangup: async () => {},
    },
    clock: { now: () => now },
    dryRun: true,
  });

  for (const [i, u] of opts.utterances.entries()) {
    // Rough speaking time: ~15 chars/s plus a short pause.
    now += 500 + u.text.length * 65;
    orch.onTranscriptDelta(u.speaker, `u${i}`, u.text);
    orch.onTranscriptDone(u.speaker, `u${i}`);
    // Each utterance is a finished turn; like the live trigger, only caller words prompt Jev.
    if (orch.pending) await orch.classify();
    await orch.idle();
  }
  orch.end();
  return {
    actions: orch.actions,
    appended,
    events,
    finalStage: orch.stage,
    lunaCalls: orch.lunaCalls,
    jevTicks: orch.jevTicks,
  };
}
