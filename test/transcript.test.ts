import { describe, expect, test } from "bun:test";
import { TranscriptBuffer } from "../src/core/transcript";

describe("transcript entries carry timing for the timeline", () => {
  const rig = () => {
    let now = 0;
    return { buf: new TranscriptBuffer(() => now), at: (ms: number) => (now = ms) };
  };

  test("item id, and when Live closed the utterance", () => {
    const { buf, at } = rig();
    at(1000);
    buf.delta("caller", "item_1", "Hello");
    at(2500);
    expect(buf.done("caller", "item_1")).toMatchObject({ itemId: "item_1", at: 1000, endAt: 2500, final: true });
  });

  test("the reply delay goes on the agent utterance that started since the caller's words", () => {
    const { buf, at } = rig();
    at(1000);
    buf.delta("caller", "c1", "Hello");
    at(1700);
    buf.delta("agent", "a1", "Hi");
    at(1800);
    expect(buf.replied(900)).toMatchObject({ itemId: "a1", replyMs: 900 });
    expect(buf.replied(100)).toBeNull(); // a1 has its delay: kept for the next agent utterance
  });

  test("measured before the agent's words show up: the next agent utterance gets it", () => {
    const { buf, at } = rig();
    at(1000);
    buf.delta("agent", "a0", "Hello?");
    at(3000);
    buf.delta("caller", "c1", "Hi");
    at(3600);
    expect(buf.replied(600)).toBeNull(); // a0 began before the caller spoke
    expect(buf.delta("agent", "a1", "Who's calling?")).toMatchObject({ replyMs: 600 });
  });

  test("a pending delay is dropped once the caller speaks again", () => {
    const { buf, at } = rig();
    at(1000);
    buf.delta("caller", "c1", "Hi");
    at(1500);
    buf.replied(500);
    buf.delta("caller", "c1", " there");
    expect(buf.delta("agent", "a1", "Hello")).not.toHaveProperty("replyMs");
  });
});
