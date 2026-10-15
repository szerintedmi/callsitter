import { describe, expect, test } from "bun:test";
import { MemoryEventBus } from "../src/core/event-bus";
import { Orchestrator, type Steer } from "../src/core/orchestrator";
import type { AgentInput } from "../src/core/ports";
import type { Suggestion } from "../src/core/types";
import { cls, loadConfigWithLuna, loadRepoConfig, scripted, type ClsInput } from "./helpers";

describe("orchestrator", () => {
  test("without {luna_response}, Live's request for help is answered at once and Luna isn't asked", async () => {
    const config = await loadRepoConfig();
    const help = config.flow.when_live_asks_for_help.tell_live;
    const sent: Steer[] = [];
    let runs = 0;
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: scripted({}),
      agent: { run: async () => (runs++, { toolCalls: [] }), summarize: async () => ({ text: "" }) },
      bus: new MemoryEventBus(),
      steer: { tellLive: (s) => void sent.push(s), hangup: async () => {} },
      clock: { now: () => 0 },
    });
    expect(await orch.delegate({ id: "d1" })).toBe(help.text);
    expect(sent).toEqual([{ message: help, source: "delegation", delegation: { id: "d1", fallback: help } }]);
    expect(runs).toBe(0);
    expect(orch.lunaCalls).toBe(0);
  });

  test("in a stage with its own help text, that text answers Live's request for help", async () => {
    const config = await loadRepoConfig();
    const help = { ...config.flow.when_live_asks_for_help.tell_live, text: "SUPERVISOR: Nothing new in this stage." };
    config.flow.rules.find((r) => r.stage === "waste_time")!.then!.when_live_asks_for_help = help.text;
    const sent: Steer[] = [];
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: scripted({}),
      agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
      bus: new MemoryEventBus(),
      steer: { tellLive: (s) => void sent.push(s), hangup: async () => {} },
      clock: { now: () => 0 },
    });
    expect(orch.enterStage("waste_time", "Waste time")).toBe(true);
    expect(await orch.delegate({ id: "d1" })).toBe(help.text);
    expect(sent.at(-1)).toEqual({ message: help, source: "delegation", delegation: { id: "d1", fallback: help } });
  });

  test("Luna's reply is sent through her rule's tell_live, and the call enters its stage", async () => {
    const config = await loadConfigWithLuna();
    const appended: unknown[] = [];
    const stages: string[] = [];
    const bus = new MemoryEventBus();
    bus.subscribe((e) => void (e.type === "stage" && stages.push(e.stage)));
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: scripted({}),
      agent: {
        run: async () => ({ instructions: "Ask for their name and the best callback number.", toolCalls: [] }),
        summarize: async () => ({ text: "" }),
      },
      bus,
      steer: { tellLive: (s) => void appended.push(s.message), hangup: async () => {} },
      clock: { now: () => 0 },
    });
    const rule = config.flow.rules.find((r) => r.stage === "low_confidence")!;
    await orch.runLuna("test", { rule: { stage: rule.stage, message: rule.then!.tell_live } });
    const reply = "Ask for their name and the best callback number.";
    expect(appended).toEqual([{ ...rule.then!.tell_live, text: rule.then!.tell_live!.text.replace("{luna_response}", reply) }]);
    expect(orch.stage).toBe("low_confidence");
    expect(stages).toEqual(["low_confidence"]);
    // A second reply in the same stage is sent, but the stage doesn't change again.
    await orch.runLuna("test", { rule: { stage: rule.stage, message: rule.then!.tell_live } });
    expect(appended).toHaveLength(2);
    expect(stages).toEqual(["low_confidence"]);
    // A Luna rule without tell_live: her tools may act, but nothing reaches Live.
    await orch.runLuna("tools only", { rule: { stage: "tools_only" } });
    expect(appended).toHaveLength(2);
    expect(orch.stage).toBe("low_confidence");
  });

  describe("classification trigger", () => {
    async function rig() {
      const config = await loadConfigWithLuna();
      config.flow.timing.classify = { settle_ms: 600, max_wait_ms: 4000, retry_min_ms: 500, retry_max_ms: 8000 };
      let now = 0;
      let release: (() => void) | null = null;
      let calls = 0;
      const orch = new Orchestrator({
        meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
        config: () => config,
        classifier: {
          async classify() {
            calls++;
            await new Promise<void>((r) => (release = r));
            return cls({ verdict: "unclear", confidence: 0.5, urgency: 0 });
          },
        },
        agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
        bus: new MemoryEventBus(),
        steer: { tellLive: () => {}, hangup: async () => {} },
        clock: { now: () => now },
      });
      const at = (ms: number) => {
        now = ms;
        orch.poll();
      };
      const finish = async () => {
        release?.();
        release = null;
        await Bun.sleep(0);
      };
      return { orch, at, finish, calls: () => calls };
    }

    test("classifies once the caller pauses for settle_ms", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hello, this is ");
      r.at(300);
      r.orch.onTranscriptDelta("caller", "c1", "Daniel from your bank.");
      r.at(800); // only 500 ms since the last words
      expect(r.calls()).toBe(0);
      r.at(900);
      expect(r.calls()).toBe(1);
      await r.finish();
      r.at(5000); // nothing new: no more calls
      expect(r.calls()).toBe(1);
    });

    test("a long monologue is classified at least every max_wait_ms", async () => {
      const r = await rig();
      for (let t = 0; t <= 4000; t += 400) {
        r.at(t);
        r.orch.onTranscriptDelta("caller", "c1", "and so on ");
      }
      r.at(4000);
      expect(r.calls()).toBe(1);
    });

    test("agent speech never triggers Jev", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("agent", "a1", "Hello? Who's calling?");
      r.at(5000);
      expect(r.calls()).toBe(0);
    });

    test("words arriving during a Jev call trigger the next one right after, no overlap", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hi there.");
      r.at(700);
      expect(r.calls()).toBe(1);
      r.orch.onTranscriptDelta("caller", "c2", "It's about your parcel.");
      r.at(1400);
      expect(r.calls()).toBe(1); // still in flight: no second call
      await r.finish();
      r.at(1500);
      expect(r.calls()).toBe(2);
      await r.finish();
    });
  });

  test("a failed Jev call is retried with capped exponential backoff", async () => {
    const config = await loadConfigWithLuna();
    config.flow.timing.classify = { settle_ms: 600, max_wait_ms: 4000, retry_min_ms: 500, retry_max_ms: 1500 };
    let now = 0;
    const attempts: number[] = [];
    let failures = 3;
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: {
        async classify() {
          attempts.push(now);
          if (failures-- > 0) throw new Error("timeout");
          return cls({ verdict: "unclear", confidence: 0.5, urgency: 0 });
        },
      },
      agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
      bus: new MemoryEventBus(),
      steer: { tellLive: () => {}, hangup: async () => {} },
      clock: { now: () => now },
    });
    orch.onTranscriptDelta("caller", "c1", "Hello?");
    for (now = 0; now <= 6000; now += 100) {
      orch.poll();
      await Bun.sleep(0);
    }
    // settle at 600, then +500, +1000, +1500 (capped); the 4th attempt succeeds and nothing is left pending.
    expect(attempts).toEqual([600, 1100, 2100, 3600]);
    expect(orch.pending).toBe(false);
    expect(orch.jevTicks).toBe(1);
  });

  test("each Luna run continues the previous completed run's conversation", async () => {
    const config = await loadConfigWithLuna();
    const seen: (string | undefined)[] = [];
    const results: (() => Promise<{ toolCalls: []; responseId?: string }>)[] = [
      async () => ({ toolCalls: [], responseId: "resp_1" }),
      async () => {
        throw new Error("timeout");
      },
      async () => ({ toolCalls: [], responseId: "resp_3" }),
    ];
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: scripted({}),
      agent: { run: async (input) => (seen.push(input.previousResponseId), results.shift()!()), summarize: async () => ({ text: "" }) },
      bus: new MemoryEventBus(),
      steer: { tellLive: () => {}, hangup: async () => {} },
      clock: { now: () => 0 },
    });
    await orch.runLuna("a");
    await orch.runLuna("b"); // fails: the chain stays at resp_1
    await orch.runLuna("c");
    expect(seen).toEqual([undefined, "resp_1", "resp_1"]);
    expect(orch.lunaResponseId).toBe("resp_3");
  });

  describe("Luna scheduling", () => {
    async function rig() {
      const config = await loadConfigWithLuna();
      config.flow.timing.classify = { settle_ms: 600, max_wait_ms: 4000, retry_min_ms: 500, retry_max_ms: 8000 };
      config.luna.limits.cooldown_ms = 15_000;
      let now = 0;
      let running = 0;
      let maxRunning = 0;
      const releases: (() => void)[] = [];
      const seen: number[] = [];
      const orch = new Orchestrator({
        meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
        config: () => config,
        classifier: scripted({ verdict: "genuine", confidence: 0.3 }),
        agent: {
          async run(input) {
            seen.push(input.transcript.length);
            maxRunning = Math.max(maxRunning, ++running);
            await new Promise<void>((r) => releases.push(r));
            running--;
            return { toolCalls: [] };
          },
          summarize: async () => ({ text: "" }),
        },
        bus: new MemoryEventBus(),
        steer: { tellLive: () => {}, hangup: async () => {} },
        clock: { now: () => now },
      });
      const at = async (ms: number) => {
        now = ms;
        orch.poll();
        await Bun.sleep(0);
      };
      const release = async () => {
        releases.shift()?.();
        await Bun.sleep(0);
      };
      return { orch, at, release, seen, maxRunning: () => maxRunning };
    }

    test("a caller turn during Luna's cooldown is supervised once the cooldown ends", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hi, it's the dentist about your appointment.");
      await r.at(700);
      expect(r.orch.lunaCalls).toBe(1);
      await r.release();
      r.orch.onTranscriptDelta("caller", "c2", "Could you ask him to call me back on 0207 946 0000?");
      await r.at(5000); // classified, but Luna is in cooldown
      expect(r.orch.lunaCalls).toBe(1);
      expect(r.orch.actions.at(-1)).toMatchObject({ kind: "luna_deferred", reason: "low confidence", stage: "low_confidence", atMs: 700 + 15_000 });
      await r.at(15_600);
      expect(r.orch.lunaCalls).toBe(1);
      await r.at(15_700); // cooldown over: no new caller words needed
      expect(r.orch.lunaCalls).toBe(2);
      expect(r.seen).toEqual([1, 2]);
      await r.release();
      await r.at(40_000); // done: not repeated
      expect(r.orch.lunaCalls).toBe(2);
    });

    test("a deferred Luna call is dropped when the call turns out to be a scam", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hello, is that you?");
      await r.at(700);
      await r.release();
      r.orch.onTranscriptDelta("caller", "c2", "I'm calling from the dentist.");
      await r.at(5000);
      expect(r.orch.actions.at(-1)?.kind).toBe("luna_deferred");
      // Next turn: confident scam → waste_time, which cancels the deferred Luna call.
      (r.orch as any).d.classifier = scripted({});
      r.orch.onTranscriptDelta("caller", "c3", "Actually, read me the code we just texted you.");
      await r.at(6000);
      expect(r.orch.actions.at(-1)?.kind).toBe("tell_live");
      await r.at(20_000);
      expect(r.orch.lunaCalls).toBe(1);
    });

    test("new words within the same utterance count as new speech for Luna", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hi, it's the dentist.");
      await r.at(700);
      expect(r.orch.lunaCalls).toBe(1);
      await r.release();
      await r.at(16_000); // cooldown over, but nothing new
      expect(r.orch.lunaCalls).toBe(1);
      // Live keeps transcribing the same utterance (same item id).
      r.orch.onTranscriptDelta("caller", "c1", " Could he call me back on 0207 946 0000?");
      await r.at(16_700);
      expect(r.orch.lunaCalls).toBe(2);
      await r.release();
    });

    test("a voice delegation waits for the Luna call in flight instead of overlapping it", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hi, it's the dentist.");
      await r.at(700);
      expect(r.orch.lunaCalls).toBe(1);
      const out = r.orch.delegate({ id: "d1" });
      await Bun.sleep(0);
      expect(r.orch.lunaCalls).toBe(1); // queued behind the running call
      let idle = false;
      void r.orch.idle().then(() => (idle = true));
      await r.release();
      expect(r.orch.lunaCalls).toBe(2);
      expect(idle).toBe(false); // the delegated call is still running
      await r.release();
      expect(await out).toBe("No specific guidance; carry on naturally.");
      await Bun.sleep(0);
      expect(idle).toBe(true);
      expect(r.maxRunning()).toBe(1);
    });
  });

  describe("guidance from before a newer decision", () => {
    /** Jev says genuine first (→ Luna), then a confident scam (→ waste_time), unless told otherwise. */
    async function rig(jev: ClsInput[] = [{ verdict: "genuine", confidence: 0.3 }, {}]) {
      const config = await loadConfigWithLuna();
      const sent: Steer[] = [];
      const notes: string[] = [];
      const releases: (() => void)[] = [];
      const bus = new MemoryEventBus();
      bus.subscribe((e) => {
        if (e.type === "note") notes.push(e.message);
        if (e.type === "luna" && e.dropped) notes.push(`Luna's guidance dropped: ${e.dropped}`);
      });
      const orch = new Orchestrator({
        meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
        config: () => config,
        classifier: scripted(...jev),
        agent: {
          async run() {
            await new Promise<void>((r) => releases.push(r));
            return { instructions: "Ask for their callback number.", toolCalls: [] };
          },
          summarize: async () => ({ text: "" }),
        },
        bus,
        steer: { tellLive: (s) => void sent.push(s), hangup: async () => {} },
        clock: { now: () => 0 },
      });
      const turnsScam = async () => {
        orch.onTranscriptDelta("caller", "c2", "Actually, read me the code we just texted you.");
        await orch.classify();
        expect(orch.stage).toBe("waste_time");
      };
      return { orch, sent, notes, releases, turnsScam, fallback: config.flow.when_live_asks_for_help.fallback, help: config.flow.when_live_asks_for_help.tell_live };
    }

    test("Luna's guidance is dropped when the call flow moved on while Luna ran", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hi, it's the dentist.");
      await r.orch.classify();
      expect(r.orch.lunaCalls).toBe(1);
      await r.turnsScam();
      r.releases.shift()!();
      await r.orch.idle();
      expect(r.sent.map((s) => s.key)).toEqual(["stage"]);
      expect(r.notes).toContain("Luna's guidance dropped: the call flow moved to waste_time while Luna ran");
    });

    test("scam → genuine (Luna starts) → scam again: the genuine-caller guidance is dropped", async () => {
      const r = await rig([{}, { verdict: "genuine", confidence: 0.3 }, {}]);
      r.orch.onTranscriptDelta("caller", "c1", "This is your bank's fraud team.");
      await r.orch.classify();
      expect(r.orch.stage).toBe("waste_time");
      r.orch.onTranscriptDelta("caller", "c2", "Sorry, wrong number, I'm calling from the dentist.");
      await r.orch.classify();
      expect(r.orch.lunaCalls).toBe(1);
      await r.turnsScam(); // waste_time again: nothing new to tell Live, but the decision changed
      r.releases.shift()!();
      await r.orch.idle();
      expect(r.sent.map((s) => s.key)).toEqual(["stage"]);
      expect(r.notes).toContain("Luna's guidance dropped: the call flow moved to waste_time while Luna ran");
    });

    test("a delegation whose guidance went stale is still answered, with the fallback", async () => {
      const r = await rig([{}]);
      r.orch.onTranscriptDelta("caller", "c1", "Hi, it's the dentist.");
      const out = r.orch.delegate({ id: "d1" });
      await Bun.sleep(0);
      await r.turnsScam();
      r.releases.shift()!();
      expect(await out).toBe("No specific guidance; carry on naturally.");
      expect(r.sent.at(-1)).toEqual({ message: r.fallback, source: "delegation", delegation: { id: "d1", fallback: r.fallback }, fallback: true });
    });

    test("guidance for a delegation goes out once, carrying its id", async () => {
      const r = await rig();
      r.orch.onTranscriptDelta("caller", "c1", "Hi, it's the dentist.");
      const out = r.orch.delegate({ id: "d1" });
      await Bun.sleep(0);
      r.releases.shift()!();
      expect(await out).toBe("Ask for their callback number.");
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]!.delegation).toEqual({ id: "d1", fallback: r.fallback });
      expect(r.sent[0]!.message.text).toBe(r.help.text.replace("{luna_response}", "Ask for their callback number."));
      expect(r.orch.stage).toBeNull(); // answering Live's request enters no stage
    });
  });
});

describe("progress summaries for the owner (luna.yaml progress)", () => {
  /** Jev's answer to owner_update, one per Jev call (the last repeats) */
  async function rig(o: { ownerStatus?: boolean; news?: number[]; failFirst?: number } = {}) {
    const config = await loadConfigWithLuna();
    config.luna.progress = { ...config.luna.progress, min_interval_ms: 5000, max_interval_ms: 30_000 };
    let now = 0;
    const calls: { transcript: string[]; owner: readonly string[] | undefined; suggestions: readonly Suggestion[] | undefined }[] = [];
    const progress: { summary: string; questions: string[] }[] = [];
    const suggestions: (Suggestion[] | undefined)[] = [];
    const reasons: string[] = [];
    const ownerUpdates: unknown[] = [];
    const lunaInputs: AgentInput[] = [];
    const marks: (number | undefined)[] = [];
    const news = o.news ?? [0.9];
    let jev = 0;
    const bus = new MemoryEventBus();
    bus.subscribe((e) => {
      if (e.type === "progress") progress.push({ summary: e.summary, questions: e.questions }), reasons.push(e.reason), suggestions.push(e.suggestions);
      if (e.type === "classification") ownerUpdates.push(e.ownerUpdate);
    });
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: {
        async classify(input) {
          marks.push(input.ownerUpdatedThrough);
          const p = news[Math.min(jev++, news.length - 1)]!;
          return cls({ verdict: "genuine", answers: { owner_update: { choice: p >= 0.5 ? "new" : "nothing_new", probabilities: { new: p, nothing_new: 1 - p } } } });
        },
      },
      agent: {
        run: async (input) => (lunaInputs.push(input), { toolCalls: [] }),
        summarize: async () => ({ text: "" }),
        progress: async (_m, t, opts) => {
          calls.push({ transcript: t.map((e) => e.text), owner: opts?.ownerMessages, suggestions: opts?.suggestions });
          if (calls.length <= (o.failFirst ?? 0)) throw new Error("Luna down");
          const sug = [{ label: " Call back ", text: " Tell her you'll call back as soon as you can. " }, { label: "", text: "x" }];
          return { summary: " Sarah is calling. ", questions: ["Is he free Tuesday?", " "], suggestions: sug, alert: false };
        },
      },
      bus,
      steer: { tellLive: () => {}, hangup: async () => {} },
      clock: { now: () => now },
      ownerStatus: () => o.ownerStatus ?? true,
    });
    let n = 0;
    /** the caller says something, pauses, and Jev answers */
    const say = async (text: string) => {
      const id = `c${++n}`;
      orch.onTranscriptDelta("caller", id, text);
      orch.onTranscriptDone("caller", id);
      now += 1000;
      orch.poll();
      await Bun.sleep(0);
      orch.poll();
      await Bun.sleep(0);
    };
    /** a poll with no new caller words */
    const tick = async () => {
      orch.poll();
      await Bun.sleep(0);
    };
    return { orch, calls, progress, suggestions, reasons, ownerUpdates, lunaInputs, marks, say, tick, advance: (ms: number) => void (now += ms) };
  }

  test("runs when Jev says there's news for the owner, at most every min_interval_ms", async () => {
    const r = await rig({ news: [0.9, 0.3, 0.95, 0.95] });
    await r.say("It's Sarah.");
    expect(r.calls).toHaveLength(1);
    expect(r.progress).toEqual([{ summary: "Sarah is calling.", questions: ["Is he free Tuesday?"] }]);
    // Jev: nothing new.
    r.advance(10_000);
    await r.say("Yeah.");
    expect(r.calls).toHaveLength(1);
    // News, then more news too soon after: it waits for the interval.
    await r.say("Is he free Tuesday?");
    expect(r.calls).toHaveLength(2);
    await r.say("Or Wednesday?");
    expect(r.calls).toHaveLength(2);
    r.advance(5000);
    await r.say("Either works.");
    expect(r.calls).toHaveLength(3);
    // Each Jev result carries its say on the summary; each run says why it ran.
    expect(r.ownerUpdates[0]).toEqual({ question: "owner_update", answer: "new", probability: 0.9, min: 0.8 });
    expect(r.reasons[0]).toBe("Jev: owner_update new 0.90 ≥ 0.8");
  });

  test("the owner's suggested buttons are trimmed, and the next run sees them", async () => {
    const r = await rig({ news: [0.9] });
    await r.say("It's Sarah.");
    const kept = [{ label: "Call back", text: "Tell her you'll call back as soon as you can." }];
    expect(r.suggestions).toEqual([kept]);
    expect(r.calls[0]!.suggestions).toEqual([]);
    r.advance(5000);
    await r.say("Can he call me?");
    expect(r.calls[1]!.suggestions).toEqual(kept);
  });

  test("Jev's transcript is marked where the last summary was written", async () => {
    const r = await rig({ news: [0.9, 0.2] });
    await r.say("It's Sarah.");
    await r.say("Yeah.");
    expect(r.marks).toEqual([undefined, 1]);
  });

  test("refreshed after max_interval_ms (default 30 s) anyway if the caller said anything", async () => {
    expect((await loadConfigWithLuna()).luna.progress.max_interval_ms).toBe(30_000);
    const r = await rig({ news: [0.1] });
    await r.say("Hmm.");
    expect(r.calls).toHaveLength(0);
    r.advance(30_000);
    await r.say("Hmm again.");
    expect(r.calls).toHaveLength(1);
    expect(r.reasons[0]).toBe("32 s since the call started, with new caller words");
  });

  test("a failed summary is retried after min_interval_ms, and Jev's marker only moves on success", async () => {
    const r = await rig({ news: [0.9, 0.2], failFirst: 1 });
    await r.say("It's Sarah.");
    expect(r.calls).toHaveLength(1);
    expect(r.progress).toEqual([]);
    // No new caller words: still retried once the interval is up.
    await r.tick();
    expect(r.calls).toHaveLength(1);
    r.advance(5000);
    await r.tick();
    expect(r.calls).toHaveLength(2);
    expect(r.progress).toHaveLength(1);
    await r.say("Yeah.");
    // Jev saw no marker until a summary went out.
    expect(r.marks).toEqual([undefined, 1]);
  });

  test("the marker leaves out an utterance still coming in", async () => {
    const r = await rig({ news: [0.9, 0.9, 0.2] });
    await r.say("It's Sarah.");
    // Sarah's next utterance is still open when the second summary runs.
    r.advance(10_000);
    r.orch.onTranscriptDelta("caller", "open", "Is he free");
    r.advance(1000);
    r.orch.poll();
    await Bun.sleep(0);
    r.orch.poll();
    await Bun.sleep(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.transcript).toEqual(["It's Sarah.", "Is he free"]);
    r.orch.onTranscriptDelta("caller", "open", " on Tuesday?");
    r.orch.onTranscriptDone("caller", "open");
    await r.say("Hello?");
    // Marker after "It's Sarah." (seq 1), so all of the open utterance (seq 2) reads as new.
    expect(r.marks.at(-1)).toBe(1);
  });

  test("off without status messages", async () => {
    const r = await rig({ ownerStatus: false });
    await r.say("It's Sarah.");
    expect(r.calls).toEqual([]);
  });

  test("the owner's messages reach Luna and the progress summary", async () => {
    const r = await rig();
    r.orch.ownerSteered("ask for her number");
    await r.say("It's Sarah.");
    expect(r.calls[0]!.owner).toEqual(["ask for her number"]);
    await r.orch.runLuna("test");
    expect(r.lunaInputs[0]!.ownerMessages).toEqual(["ask for her number"]);
  });
});

describe("call costs", () => {
  test("Luna is priced from her tokens: uncached, cached and cache-write input, output, times the tier", async () => {
    const { priceLuna } = await import("../src/core/cost");
    const config = await loadConfigWithLuna();
    const u = { model: "gpt-6-luna", inputTokens: 2_000_000, cachedTokens: 1_000_000, cacheWriteTokens: 500_000, outputTokens: 1_000_000, reasoningTokens: 0 };
    // 0.5M uncached × $0.1 + 1M cached × $0.01 + 0.5M writes × $0.125 + 1M out × $0.5
    expect(priceLuna(u, config.cost).costUsd).toBeCloseTo(0.05 + 0.01 + 0.0625 + 0.5, 6);
    expect(priceLuna({ ...u, serviceTier: "priority" }, config.cost).costUsd).toBeCloseTo(2 * 0.6225, 6);
    expect(priceLuna({ ...u, serviceTier: "default" }, config.cost).costUsd).toBeCloseTo(0.6225, 6);
  });

  test("each Luna run's usage is priced on its event and added to the call's costs", async () => {
    const config = await loadConfigWithLuna();
    const lunaEvents: unknown[] = [];
    const bus = new MemoryEventBus();
    bus.subscribe((e) => void (e.type === "luna" && lunaEvents.push(e.usage)));
    const orch = new Orchestrator({
      meta: { callId: "c", from: "+441", to: "+442", channel: "phone", startedAt: 0 },
      config: () => config,
      classifier: scripted({}),
      agent: {
        run: async () => ({ toolCalls: [], usage: { model: "gpt-6-luna", inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } }),
        summarize: async () => ({ text: "" }),
      },
      bus,
      steer: { tellLive: () => {}, hangup: async () => {} },
      clock: { now: () => 0 },
    });
    await orch.runLuna("test");
    await orch.runLuna("test");
    expect(lunaEvents).toEqual([expect.objectContaining({ costUsd: 0.1 }), expect.objectContaining({ costUsd: 0.1 })]);
    const costs = orch.costs.total(120);
    expect(costs).toMatchObject({ liveSeconds: 120, liveUsd: 0.1, lunaUsd: 0.2, totalUsd: 0.3, luna: { calls: 2, inputTokens: 2_000_000 } });
    expect(costs.carrierUsd).toBeUndefined();
    // The carrier's bill, set (not added) as it may arrive twice.
    orch.costs.carrierUsd = 0.02;
    orch.costs.carrierUsd = 0.025;
    expect(orch.costs.total(120)).toMatchObject({ carrierUsd: 0.025, totalUsd: 0.325 });
  });
});
