import { describe, expect, test } from "bun:test";
import { b64decode, b64encode, swap16 } from "../src/core/audio";
import { TranscriptSegmenter } from "../src/adapters/openai-live/segmenter";

describe("audio helpers", () => {
  test("base64 round trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 7, 8]);
    const b64 = b64encode(bytes);
    expect(b64decode(b64)).toEqual(bytes);
  });

  test("swap16 flips byte order", () => {
    expect(swap16(new Uint8Array([1, 2, 3, 4]))).toEqual(new Uint8Array([2, 1, 4, 3]));
  });
});

describe("Live transcript segmenter", () => {
  const collect = () => {
    const log: string[] = [];
    let now = 0;
    const seg = new TranscriptSegmenter(
      { delta: (s, id, d) => log.push(`${s}:${id}:+${d}`), done: (s, id) => log.push(`${s}:${id}:done`) },
      900,
      1500,
      () => now,
    );
    return { log, seg, tick: (ms: number) => (now += ms) };
  };

  test("groups contiguous deltas and splits on speaker change", () => {
    const { log, seg } = collect();
    seg.push("agent", "Hello", 0, 300);
    seg.push("agent", "?", 300, 400);
    seg.push("caller", "Hi", 800, 1000);
    seg.flush();
    expect(log).toEqual(["agent:agent-1:+Hello", "agent:agent-1:+?", "agent:agent-1:done", "caller:caller-2:+Hi", "caller:caller-2:done"]);
  });

  test("drops non-speech tags, also split over deltas, without cutting the other side", () => {
    const { log, seg } = collect();
    seg.push("agent", "Right, what's your", 0, 400);
    seg.push("caller", "[ch", 300, 350);
    seg.push("agent", " number?", 400, 800);
    seg.push("caller", "uckle]", 500, 600);
    seg.push("caller", "? [laugh]", 700, 750);
    seg.push("agent", "[mouth noise] Okay.", 2000, 2400);
    seg.flush();
    expect(log).toEqual([
      "agent:agent-1:+Right, what's your",
      "agent:agent-1:+ number?",
      "agent:agent-1:done",
      "agent:agent-2:+ Okay.",
      "agent:agent-2:done",
    ]);
  });

  test("an unclosed tag ends at a timeline gap", () => {
    const { log, seg } = collect();
    seg.push("caller", "Yes [laugh", 0, 300);
    seg.push("caller", "hello", 2000, 2300);
    seg.flush();
    expect(log).toEqual(["caller:caller-1:+Yes ", "caller:caller-1:done", "caller:caller-2:+hello", "caller:caller-2:done"]);
  });

  test("splits on a timeline gap and on idle", () => {
    const { log, seg, tick } = collect();
    seg.push("caller", "one", 0, 500);
    seg.push("caller", "two", 2000, 2500);
    tick(2000);
    seg.sweep();
    expect(log).toEqual(["caller:caller-1:+one", "caller:caller-1:done", "caller:caller-2:+two", "caller:caller-2:done"]);
  });
});
