import OpenAI from "openai";
import type { FunctionTool, Response, ResponseInputItem } from "openai/resources/responses/responses";
import { fillCurrentTime, type LunaConfig, type LunaTool } from "../../core/config";
import type { Agent, AgentInput, AgentResult, ToolContext } from "../../core/ports";
import type { CallMeta, Classification, ToolCallRecord, TranscriptEntry } from "../../core/types";
import { renderTranscript } from "../jev/classifier";

// GPT-6 Luna via the Responses API with function tools
// (https://developers.openai.com/api/docs/models/gpt-6-luna).
// A call's Luna runs are chained with previous_response_id, so Luna sees its earlier guidance
// and tool results; each run still sends the full transcript, which replaces earlier copies.
// Instructions aren't carried along a chain, so every request sends them
// (https://developers.openai.com/api/docs/guides/conversation-state).

const MAX_TOOL_ROUNDS = 3;

export const TOOL_DEFS: Record<LunaTool, FunctionTool> = {
  send_telegram_to_owner: {
    type: "function",
    name: "send_telegram_to_owner",
    description: "Send the phone's owner a short Telegram message about this call: who is calling, why, and how to reach them if known.",
    strict: true,
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "message text, under 500 characters" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
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
  take_message: {
    type: "function",
    name: "take_message",
    description: "Record a message for the owner once the caller's details are known.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: ["string", "null"], description: "caller's name" },
        callback: { type: ["string", "null"], description: "callback number" },
        message: { type: "string" },
      },
      required: ["name", "callback", "message"],
      additionalProperties: false,
    },
  },
};

export function renderContext(meta: CallMeta, transcript: readonly TranscriptEntry[], c: Classification | null, reason: string) {
  const lines = [
    `Caller number: ${meta.from || "unknown"}${meta.divertedFrom ? ` (diverted from ${meta.divertedFrom})` : ""}`,
    `Why you are being consulted: ${reason}`,
  ];
  if (c) {
    lines.push(
      `Classifier: verdict=${c.verdict} (confidence ${c.confidence.toFixed(2)}), urgency=${c.urgency.toFixed(2)}`,
    );
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
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  let result: string;
  switch (name) {
    case "send_telegram_to_owner":
      result = await tools.sendTelegramToOwner(String(args.text ?? ""));
      break;
    case "end_call":
      result = await tools.endCall(String(args.reason ?? ""));
      break;
    case "take_message":
      result = await tools.takeMessage({
        name: str(args.name),
        callback: str(args.callback),
        message: String(args.message ?? ""),
      });
      break;
    default:
      result = `error: unknown tool ${name}`;
  }
  return { name, args, result };
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
      console.warn(`[luna] could not continue ${previousId}, starting afresh: ${err instanceof Error ? err.message : err}`);
      return create(undefined);
    }
  }

  async run(input: AgentInput): Promise<AgentResult> {
    const cfg = this.opts.config();
    const tools = input.enabledTools.map((t) => TOOL_DEFS[t]);
    const instructions = fillCurrentTime(cfg.instructions, Date.now());
    const toolCalls: ToolCallRecord[] = [];
    let conversation: ResponseInputItem[] = [
      { role: "user", content: renderContext(input.meta, input.transcript, input.classification, input.reason) },
    ];
    let previousId = input.previousResponseId;

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
      const calls = res.output.filter((o) => o.type === "function_call");
      if (calls.length === 0) return { instructions: res.output_text.trim() || undefined, toolCalls, responseId: res.id };

      const outputs: ResponseInputItem[] = [];
      for (const call of calls) {
        const rec = await execTool(call.name, call.arguments, input.tools);
        toolCalls.push(rec);
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: rec.result });
      }
      previousId = res.id;
      conversation = outputs;
    }
    return { toolCalls };
  }

  async summarize(meta: CallMeta, transcript: readonly TranscriptEntry[], opts: { previousResponseId?: string } = {}): Promise<string> {
    const cfg = this.opts.config();
    const res = await this.createChained(opts.previousResponseId, (prev) =>
      this.client.responses.create({
        model: cfg.model,
        instructions: cfg.summary_instructions,
        input: renderContext(meta, transcript, null, "end-of-call summary"),
        previous_response_id: prev,
        reasoning: { effort: "low" },
        store: false,
      }),
    );
    return res.output_text.trim();
  }
}
