import { describe, expect, test } from "bun:test";
import { LunaAgent } from "../src/adapters/luna/agent";
import type { AgentInput } from "../src/core/ports";
import { loadConfigWithLuna } from "./helpers";

// LunaAgent against a fake Responses API endpoint.

const text = (id: string, t: string) => ({
  id,
  object: "response",
  output: [{ type: "message", id: `m_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: t, annotations: [] }] }],
});
const toolCall = (id: string, name: string, args: object) => ({
  id,
  object: "response",
  output: [{ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: "completed" }],
});

async function rig(replies: (object | { status: number; error: string })[]) {
  const config = await loadConfigWithLuna();
  const requests: any[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const r = replies.shift()!;
    if ("status" in r) return Response.json({ error: { message: r.error } }, { status: r.status as number });
    return Response.json(r);
  }) as unknown as typeof globalThis.fetch;
  const agent = new LunaAgent({ apiKey: "k", config: () => config.luna, fetch });
  const input = (p: Partial<AgentInput> = {}): AgentInput => ({
    meta: { callId: "c", from: "+441", to: "+442", startedAt: 0 },
    transcript: [{ seq: 1, speaker: "caller", text: "It's Sarah, ask him to call me back.", at: 0, final: true }],
    classification: null,
    reason: "genuine caller",
    enabledTools: ["end_call"],
    tools: { endCall: async () => "ending call" },
    ...p,
  });
  return { agent, requests, input, config };
}

describe("Luna adapter", () => {
  test("a run returns the final response id; tool rounds chain within the run", async () => {
    const r = await rig([toolCall("r1", "end_call", { reason: "done" }), text("r2", "Say goodbye.")]);
    const res = await r.agent.run(r.input());
    expect(res).toMatchObject({ instructions: "Say goodbye.", responseId: "r2" });
    expect(r.requests[0].previous_response_id).toBeUndefined();
    expect(r.requests[1].previous_response_id).toBe("r1");
    expect(r.requests[1].input).toEqual([{ type: "function_call_output", call_id: "call_r1", output: "ending call" }]);
    // Not inherited along a chain; {current_time} is filled per run.
    expect(new Set(r.requests.map((q) => q.instructions)).size).toBe(1);
    expect(r.requests[0].instructions).toStartWith(r.config.luna.instructions!.split("{current_time}")[0]!);
    expect(r.requests[0].instructions).not.toContain("{current_time}");
  });

  test("the next run continues the chain and resends the full transcript", async () => {
    const r = await rig([text("r3", "")]);
    await r.agent.run(r.input({ previousResponseId: "r2" }));
    expect(r.requests[0].previous_response_id).toBe("r2");
    expect(r.requests[0].input[0].content).toContain("Transcript so far (replaces any earlier copy):\ncaller: It's Sarah");
  });

  test("a broken chain (expired response) starts afresh instead of failing", async () => {
    const r = await rig([{ status: 404, error: "Previous response with id 'r2' not found." }, text("r4", "Carry on.")]);
    const res = await r.agent.run(r.input({ previousResponseId: "r2" }));
    expect(res.responseId).toBe("r4");
    expect(r.requests.map((q) => q.previous_response_id)).toEqual(["r2", undefined]);
  });

  test("the summary continues Luna's conversation when there is one", async () => {
    const r = await rig([text("s1", "Sarah called; message taken."), text("s2", "Nobody said much.")]);
    const meta = { callId: "c", from: "+441", to: "+442", startedAt: 0 };
    expect((await r.agent.summarize(meta, [], { previousResponseId: "r2" })).text).toBe("Sarah called; message taken.");
    expect((await r.agent.summarize(meta, [])).text).toBe("Nobody said much.");
    expect(r.requests.map((q) => q.previous_response_id)).toEqual(["r2", undefined]);
    expect(r.requests[0].instructions).toBe(r.config.luna.summary_instructions);
  });

  test("the owner's messages are part of every run's context", async () => {
    const r = await rig([text("r1", "")]);
    await r.agent.run(r.input({ ownerMessages: ["ask for her number"] }));
    expect(JSON.stringify(r.requests[0].input)).toContain("- ask for her number");
  });

  test("progress: a structured summary, open questions, suggestions and alert, not chained", async () => {
    const suggestions = [{ label: "Call back soon", text: "Tell her you'll call back as soon as you can." }];
    const r = await rig([text("p1", JSON.stringify({ summary: "Sarah wants a call back.", questions: ["Is he free Tuesday?"], suggestions, alert: true }))]);
    const out = await r.agent.progress(r.input().meta, r.input().transcript, { ownerMessages: ["be nice"], suggestions: [{ label: "Ask why", text: "Ask what it's about." }] });
    expect(out).toMatchObject({ summary: "Sarah wants a call back.", questions: ["Is he free Tuesday?"], suggestions, alert: true });
    const req = r.requests[0];
    expect(req.text.format).toMatchObject({ type: "json_schema", strict: true, name: "call_progress" });
    expect(req.previous_response_id).toBeUndefined();
    expect(req.instructions).toBe(r.config.luna.progress.instructions);
    expect(req.input).toContain("- be nice");
    expect(req.input).toContain("- Ask why: Ask what it's about.");
  });

  test("usage: every response of a run is summed, with the tier it ran on", async () => {
    const usage = (i: number, c: number, w: number, o: number, r: number) => ({
      input_tokens: i,
      input_tokens_details: { cached_tokens: c, cache_write_tokens: w },
      output_tokens: o,
      output_tokens_details: { reasoning_tokens: r },
      total_tokens: i + o,
    });
    const r = await rig([
      { ...toolCall("r1", "end_call", { reason: "x" }), model: "gpt-6-luna", service_tier: "priority", usage: usage(1000, 800, 100, 50, 20) },
      { ...text("r2", "Ask for a number."), model: "gpt-6-luna", service_tier: "priority", usage: usage(1200, 1000, 0, 30, 10) },
    ]);
    const res = await r.agent.run(r.input());
    expect(res.usage).toEqual({
      model: "gpt-6-luna",
      serviceTier: "priority",
      inputTokens: 2200,
      cachedTokens: 1800,
      cacheWriteTokens: 100,
      outputTokens: 80,
      reasoningTokens: 30,
    });
  });
});
