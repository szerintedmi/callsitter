import OpenAI from "openai";
import type { FunctionTool, Response, ResponseInputItem } from "openai/resources/responses/responses";
import { fillCurrentTime, type LunaConfig, type LunaTool } from "../../core/config";
import { logger } from "../../core/log";
import type { Agent, AgentInput, AgentResult, Progress, SummaryResult, ToolContext } from "../../core/ports";
import type { CallMeta, Classification, Suggestion, TokenUsage, ToolCallRecord, TranscriptEntry } from "../../core/types";
import { renderTranscript } from "../jev/classifier";

const log = logger("luna");

// GPT-6 Luna via the Responses API with function tools
// (https://developers.openai.com/api/docs/models/gpt-6-luna).
// A call's Luna runs are chained with previous_response_id, so Luna sees its earlier guidance
// and tool results; each run still sends the full transcript, which replaces earlier copies.
// Instructions aren't carried along a chain, so every request sends them
// (https://developers.openai.com/api/docs/guides/conversation-state).

const MAX_TOOL_ROUNDS = 3;

export const TOOL_DEFS: Record<LunaTool, FunctionTool> = {
  end_call: {
    type: "function",
    name: "end_call",
    description: "Hang up the call. Only when the conversation is clearly finished or abusive.",
    strict: true,
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
};

export function renderContext(
  meta: CallMeta,
  transcript: readonly TranscriptEntry[],
  c: Classification | null,
  reason: string,
  ownerMessages: readonly string[] = [],
  stage?: string | null,
) {
  const lines = [
    `Caller number: ${meta.from || "unknown"}${meta.divertedFrom ? ` (diverted from ${meta.divertedFrom})` : ""}`,
    `Why you are being consulted: ${reason}`,
  ];
  if (c) {
    lines.push(
      `Classifier: verdict=${c.verdict} (confidence ${c.confidence.toFixed(2)}), urgency=${c.urgency.toFixed(2)}`,
    );
  }
  if (stage !== undefined) {
    lines.push(`How the agent was told to handle the call (call-flow stage): ${stage ? stage.replaceAll("_", " ") : "not told yet (unclear)"}`);
  }
  if (ownerMessages.length) {
    lines.push("", "The phone's owner told the agent during the call (oldest first); follow it:", ...ownerMessages.map((m) => `- ${m}`));
  }
  lines.push("", "Transcript so far (replaces any earlier copy):", renderTranscript(transcript) || "(nothing yet)");
  return lines.join("\n");
}

async function execTool(name: string, argsJson: string, tools: ToolContext): Promise<ToolCallRecord> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return { name, args: { raw: argsJson }, result: "error: arguments were not valid JSON" };
  }
  let result: string;
  switch (name) {
    case "end_call":
      result = await tools.endCall(String(args.reason ?? ""));
      break;
    default:
      result = `error: unknown tool ${name}`;
  }
  return { name, args, result };
}

/** A response's token usage, added to `sum` (a run's tool rounds are several responses). */
export function usageOf(res: Response, sum?: TokenUsage): TokenUsage {
  const u = res.usage;
  const add = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0);
  const tier = sum?.serviceTier ?? res.service_tier;
  return {
    model: sum?.model ?? res.model,
    ...(tier ? { serviceTier: tier } : {}),
    inputTokens: add(sum?.inputTokens, u?.input_tokens),
    cachedTokens: add(sum?.cachedTokens, u?.input_tokens_details?.cached_tokens),
    cacheWriteTokens: add(sum?.cacheWriteTokens, u?.input_tokens_details?.cache_write_tokens),
    outputTokens: add(sum?.outputTokens, u?.output_tokens),
    reasoningTokens: add(sum?.reasoningTokens, u?.output_tokens_details?.reasoning_tokens),
  };
}

/**
 * The text of a response's answer. The model may first send a `commentary` message (for
 * Structured Outputs, a draft of the JSON) before the `final_answer` one; `output_text` joins
 * them all, so read only the final answer (or the last message, when phases aren't set).
 */
export function answerText(res: Response): string {
  const messages = res.output.filter((o) => o.type === "message");
  const answer = messages.findLast((m) => m.phase === "final_answer") ?? messages.at(-1);
  return (answer?.content ?? []).map((c) => (c.type === "output_text" ? c.text : "")).join("");
}

/** The chained response is gone or unusable (e.g. expired): start a fresh chain instead. */
const isBrokenChain = (err: unknown) => err instanceof OpenAI.APIError && (err.status === 400 || err.status === 404);

export class LunaAgent implements Agent {
  private client: OpenAI;

  constructor(private opts: { apiKey: string; config: () => LunaConfig; fetch?: typeof fetch }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  /** Creates a response continuing `previousId`; if that chain is broken, retries without it. */
  private async createChained(previousId: string | undefined, create: (previousId: string | undefined) => Promise<Response>) {
    try {
      return await create(previousId);
    } catch (err) {
      if (!previousId || !isBrokenChain(err)) throw err;
      log.warn("could not continue the previous response, starting afresh", { previousId, err });
      return create(undefined);
    }
  }

  async run(input: AgentInput): Promise<AgentResult> {
    const cfg = this.opts.config();
    const tools = input.enabledTools.map((t) => TOOL_DEFS[t]);
    const instructions = fillCurrentTime(cfg.instructions ?? "", Date.now());
    const toolCalls: ToolCallRecord[] = [];
    let conversation: ResponseInputItem[] = [
      { role: "user", content: renderContext(input.meta, input.transcript, input.classification, input.reason, input.ownerMessages) },
    ];
    let previousId = input.previousResponseId;
    let usage: TokenUsage | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const create = (prev: string | undefined) =>
        this.client.responses.create(
          {
            model: cfg.model,
            instructions,
            input: conversation,
            previous_response_id: prev,
            tools: round < MAX_TOOL_ROUNDS ? tools : [],
            reasoning: { effort: cfg.reasoning_effort },
            service_tier: cfg.service_tier,
            store: true,
          },
          { signal: input.signal },
        );
      // Only the first request continues an earlier run; later rounds carry tool outputs, which
      // belong to the response just made and can't be sent anywhere else.
      const res = round === 0 ? await this.createChained(previousId, create) : await create(previousId);
      usage = usageOf(res, usage);
      const calls = res.output.filter((o) => o.type === "function_call");
      if (calls.length === 0) return { instructions: answerText(res).trim() || undefined, toolCalls, responseId: res.id, usage };

      const outputs: ResponseInputItem[] = [];
      for (const call of calls) {
        const rec = await execTool(call.name, call.arguments, input.tools);
        toolCalls.push(rec);
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: rec.result });
      }
      previousId = res.id;
      conversation = outputs;
    }
    return { toolCalls, usage };
  }

  async summarize(
    meta: CallMeta,
    transcript: readonly TranscriptEntry[],
    opts: { previousResponseId?: string; ownerMessages?: readonly string[]; stage?: string | null } = {},
  ): Promise<SummaryResult> {
    const cfg = this.opts.config();
    const res = await this.createChained(opts.previousResponseId, (prev) =>
      this.client.responses.create({
        model: cfg.model,
        instructions: cfg.summary_instructions,
        input: renderContext(meta, transcript, null, "end-of-call summary", opts.ownerMessages, opts.stage),
        previous_response_id: prev,
        reasoning: { effort: "low" },
        store: false,
      }),
    );
    return { text: answerText(res).trim(), usage: usageOf(res) };
  }

  /**
   * Rolling summary, open questions, steering buttons and alert for the owner (luna.yaml progress),
   * as Structured Outputs; not chained. The fields are described in progress.instructions.
   */
  async progress(
    meta: CallMeta,
    transcript: readonly TranscriptEntry[],
    opts: { ownerMessages?: readonly string[]; suggestions?: readonly Suggestion[]; stage?: string | null; signal?: AbortSignal } = {},
  ): Promise<Progress> {
    const cfg = this.opts.config();
    let input = renderContext(meta, transcript, null, "status update for the owner while the call goes on", opts.ownerMessages, opts.stage);
    if (opts.suggestions?.length) {
      input += "\n\nThe owner's current buttons (label: text):\n" + opts.suggestions.map((s) => `- ${s.label}: ${s.text}`).join("\n");
    }
    const res = await this.client.responses.create(
      {
        model: cfg.model,
        instructions: cfg.progress.instructions,
        input,
        reasoning: { effort: cfg.progress.reasoning_effort },
        text: { format: { type: "json_schema", name: "call_progress", strict: true, schema: PROGRESS_SCHEMA } },
        store: false,
      },
      { signal: opts.signal },
    );
    const out = JSON.parse(answerText(res)) as Partial<Progress>;
    return {
      summary: typeof out.summary === "string" ? out.summary : "",
      questions: Array.isArray(out.questions) ? out.questions.filter((q): q is string => typeof q === "string") : [],
      suggestions: Array.isArray(out.suggestions)
        ? out.suggestions.filter((s): s is Suggestion => typeof s?.label === "string" && typeof s.text === "string")
        : [],
      alert: out.alert === true,
      usage: usageOf(res),
    };
  }
}

const PROGRESS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, text: { type: "string" } },
        required: ["label", "text"],
        additionalProperties: false,
      },
    },
    alert: { type: "boolean" },
  },
  required: ["summary", "questions", "suggestions", "alert"],
  additionalProperties: false,
};
