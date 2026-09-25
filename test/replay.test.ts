import { describe, expect, test } from "bun:test";
import type { Agent } from "../src/core/ports";
import { parseTranscript, replay } from "../src/replay/harness";
import { KeywordClassifier } from "../src/replay/keyword-classifier";
import { loadRepoConfig, scripted } from "./helpers";

const fixture = async (name: string) => parseTranscript(await Bun.file(`test/fixtures/${name}`).text());

describe("replay harness", () => {
  test("parses transcripts and rejects bad lines", () => {
    expect(parseTranscript("# c\ncaller: hi\n\nAgent: hello")).toEqual([
      { speaker: "caller", text: "hi" },
      { speaker: "agent", text: "hello" },
    ]);
    expect(() => parseTranscript("bob: hi")).toThrow(/bad transcript line/);
  });

  test("scam fixture → one tell_live appended, no Luna", async () => {
    const res = await replay({
      utterances: await fixture("scam-bank.txt"),
      config: await loadRepoConfig(),
      classifier: new KeywordClassifier(),
    });
    expect(res.finalStage).toBe("waste_time");
    expect(res.actions.filter((a) => a.kind === "tell_live")).toHaveLength(1);
    expect(res.appended).toHaveLength(1);
    expect(res.lunaCalls).toBe(0);
  });

  test("genuine fixture → no Luna during the call; after it she texts the owner (dry run)", async () => {
    const agent: Agent = {
      async run(input) {
        const r = await input.tools.sendSmsToOwner("Sarah at Parkside Dental: appointment moved to 11:30. 020 7946 0321");
        return { instructions: "Thank her and say Alex will call back.", toolCalls: [{ name: "send_sms_to_owner", args: {}, result: r }] };
      },
      async summarize() {
        return "";
      },
    };
    const res = await replay({
      utterances: await fixture("genuine-dentist.txt"),
      config: await loadRepoConfig(),
      classifier: new KeywordClassifier(),
      agent,
    });
    expect(res.lunaCalls).toBe(1);
    expect(res.events.find((e) => e.type === "luna.started")).toMatchObject({ trigger: "after_call" });
    expect(res.finalStage).toBe("genuine");
    // Only the genuine stage text: her reply after the call goes nowhere.
    expect(res.appended.map((m) => m.as)).toEqual(["thinking"]);
    const tool = res.events.find((e) => e.type === "tool");
    expect(tool?.type === "tool" && tool.call.result).toBe("dry run: not sent");
  });

  test("the time-wasting text is sent once while the call stays a scam", async () => {
    const cfg = await loadRepoConfig();
    const res = await replay({
      utterances: [
        { speaker: "caller", text: "This is your bank calling about suspicious payments on your account." },
        { speaker: "caller", text: "I need you to read me the security code we just sent you, please." },
      ],
      config: cfg,
      classifier: scripted({}),
    });
    expect(res.actions.map((a) => a.kind === "tell_live" && a.stage)).toEqual(["waste_time"]);
  });

  test("Jev runs after caller turns only, not after the agent's", async () => {
    const classifier = scripted({ verdict: "unclear", confidence: 0.5 });
    await replay({
      utterances: [
        { speaker: "agent", text: "Hello?" },
        { speaker: "caller", text: "Hi" },
        { speaker: "agent", text: "Who's calling, please?" },
        { speaker: "agent", text: "Hello? Are you there?" },
      ],
      config: await loadRepoConfig(),
      classifier,
    });
    expect(classifier.calls).toBe(1);
  });
});
