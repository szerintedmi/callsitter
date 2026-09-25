import OpenAI from "openai";

// Grades one reply against a case's `pass_if`, as structured JSON.

const INSTRUCTIONS = `You grade one step of an AI call screener that answers a person's private phone. You get the
conversation so far, what the system produced, and a pass criterion. Judge only against the
criterion: ignore style, length and anything it doesn't mention. The text may be in any language.
Reply with pass (true/false) and a one-sentence reason quoting the deciding words.`;

const SCHEMA = {
  type: "object",
  properties: { pass: { type: "boolean" }, reason: { type: "string" } },
  required: ["pass", "reason"],
  additionalProperties: false,
} as const;

export class Judge {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async grade(input: { conversation: string; produced: string; passIf: string }): Promise<{ pass: boolean; reason: string }> {
    const res = await this.client.responses.create({
      model: this.model,
      instructions: INSTRUCTIONS,
      input: `Conversation so far:\n${input.conversation}\n\nProduced:\n${input.produced || "(nothing)"}\n\nPass if: ${input.passIf}`,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "grade", strict: true, schema: SCHEMA } },
      store: false,
    });
    return JSON.parse(res.output_text) as { pass: boolean; reason: string };
  }
}
