import { describe, expect, test } from "bun:test";
import { FS_OFF, fsStep, type FsState } from "../src/web/client/listen-story";

// The player's fullscreen (listen-fullscreen.ts): what each event does (listen-story.ts fsStep).
describe("player fullscreen", () => {
  const on: FsState = { on: true, by: "button", pushed: true };
  const rotate = (landscape: boolean, playing = true, touch = true) => ({ type: "rotate" as const, landscape, playing, touch });

  test("the button toggles: in with a history entry and a landscape lock, out popping it", () => {
    expect(fsStep(FS_OFF, { type: "button" })).toEqual({ state: on, effects: ["enter", "push", "lock"] });
    expect(fsStep(on, { type: "button" })).toEqual({ state: FS_OFF, effects: ["exit", "pop"] });
  });

  test("a phone turned to landscape while playing goes in; back to portrait comes out", () => {
    const r = fsStep(FS_OFF, rotate(true));
    expect(r).toEqual({ state: { on: true, by: "rotate", pushed: true }, effects: ["enter", "push"] });
    expect(fsStep(r.state, rotate(false)).effects).toEqual(["exit", "pop"]);
    // paused, or a desktop: nothing
    expect(fsStep(FS_OFF, rotate(true, false)).effects).toEqual([]);
    expect(fsStep(FS_OFF, rotate(true, true, false)).effects).toEqual([]);
    // already in (by the button): turning to landscape changes nothing
    expect(fsStep(on, rotate(true))).toEqual({ state: on, effects: [] });
  });

  test("Back leaves without popping again; Escape and the browser's own exit pop", () => {
    expect(fsStep(on, { type: "back" })).toEqual({ state: FS_OFF, effects: ["exit"] });
    expect(fsStep(on, { type: "escape" }).effects).toEqual(["exit", "pop"]);
    expect(fsStep(on, { type: "native-exit" }).effects).toEqual(["exit", "pop"]);
    expect(fsStep(FS_OFF, { type: "back" }).effects).toEqual([]);
  });
});
