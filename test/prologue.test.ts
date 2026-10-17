import { describe, expect, test } from "bun:test";
import { beatsFrom, piecesOf, soundsOf, timesOf, type PrologueSpec } from "../demos/tools/prologue";
import { retime, trimSamples, trimmer } from "../demos/tools/timeline";
import { blinkAt, cameraAt, clockAt, clockTime, keyTimes, shownLines, soloAt, songBanner, stagingAt, type Prologue } from "../src/web/client/listen-story";

// A demo's prologue (build.ts --prologue, the player's listen-prologue.ts): its storyboard's times,
// the off-limits guard, the sounds that come with its beats; and the build moving the call's times
// (trims, the prologue before it) and the song's banner coming in early.

const spec: Pick<PrologueSpec, "voice" | "marks" | "duration" | "offLimits" | "sfx"> = {
  duration: "end",
  marks: { stage: "intro.end+0.6", lapse: "stage+3.3", land: "lapse+2", end: "land+1.5" },
  voice: [
    { id: "who", at: 1, from: 12, to: 13.5 },
    { id: "intro", at: "who.end+0.5", from: 15, to: 18, speaker: "caller" },
    { id: "think", at: "lapse+0.1", from: 158, to: 159 },
    { id: "wall", at: "land", from: 436, until: "end", speaker: "both", gain: -22 },
  ],
  offLimits: [{ speaker: "caller", from: 0, to: 14.8 }, { speaker: "caller", from: 448.4 }],
  sfx: [{ at: "stage", sound: "pop", gain: -18 }],
};

describe("prologue times", () => {
  const time = timesOf(spec, 40);

  test("names chain: lines' starts and ends, marks, the call and its song", () => {
    expect(time("who.end")).toBe(2.5);
    expect(time("intro")).toBe(3);
    expect(time("stage")).toBe(6.6);
    expect(time("lapse-0.1")).toBe(9.8);
    expect(time("call")).toBe(13.4);
    expect(time("song+1")).toBe(54.4);
    expect(time(2)).toBe(2);
    // a line with "until" ends there
    expect(time("wall.end")).toBe(13.4);
  });

  test("unknown names, loops and a song that isn't there stop it", () => {
    expect(() => time("nope")).toThrow(/no time named/);
    expect(() => timesOf({ ...spec, marks: { a: "b", b: "a+1" } })("a")).toThrow(/itself/);
    expect(() => timesOf(spec)("song")).toThrow(/no song/);
  });

  test("a line touching the off-limits stretches is refused, on either side of a both-sides one", () => {
    expect(piecesOf(spec, time).map((p) => [p.at, p.to])).toEqual([[1, 13.5], [3, 18], [10, 159], [11.9, 437.5]]);
    expect(() => piecesOf({ ...spec, voice: [{ at: 0, from: 14, to: 16, speaker: "caller" }] }, time)).toThrow(/off-limits 0–14.8/);
    expect(() => piecesOf({ ...spec, voice: [{ at: 0, from: 448, to: 449, speaker: "both", gain: -20 }] }, time)).toThrow(/off-limits 448.4–end/);
    // the bot's side has no off-limits
    expect(piecesOf({ ...spec, voice: [{ at: 0, from: 5, to: 6 }] }, time)).toHaveLength(1);
    // both sides only in the background
    expect(() => piecesOf({ ...spec, voice: [{ at: 0, from: 20, to: 21, speaker: "both" }] }, time)).toThrow(/background/);
  });

  test("beats resolved; a clock's keys from the lines inside it; their sounds", () => {
    const pieces = piecesOf(spec, time);
    const beats = beatsFrom(
      {
        beats: [
          { type: "ring", start: 0, end: 1, id: "X", buzz: [0.2, "who-0.5"], answer: 0.9 },
          { type: "clock", start: "lapse", land: "land", to: 450, end: "song" },
          { type: "card", start: "land", end: "land+1", text: "LATER", sound: "pop" },
          { type: "phone", start: "land", end: "call+3", typing: ["land+0.1", "land+0.5"], sent: "land+0.6", handoff: "end", text: "Hi 😄" },
        ],
      },
      time,
      pieces,
      451.2,
    );
    expect(beats[0]).toMatchObject({ buzz: [0.2, 0.5] });
    // through 0 at its start, the line's middle at its own time, the landing value
    expect(beats[1]).toMatchObject({ start: 9.9, land: 11.9, end: 53.4, call: 451.2, keys: [[9.9, 0], [10.5, 158.5], [11.9, 450]] });
    expect(beats[3]).toMatchObject({ end: 16.4, sent: 12.5 });
    const sounds = soundsOf(spec, beats, pieces, time);
    const names = (n: string) => sounds.filter((s) => s.sound === n);
    expect(names("buzz").map((s) => s.at)).toEqual([0.2, 0.5]);
    expect(names("click")[0]!.at).toBe(1);
    expect(names("pop").map((s) => s.at).sort()).toEqual([11.9, 6.6]);
    expect(names("thump")[0]!.at).toBe(11.9);
    expect(names("bed")[0]!.params).toMatchObject({ d: 2 });
    // a key per character, the emoji one
    expect(names("key")).toHaveLength(4);
    expect(names("tick").length).toBeGreaterThan(50);
    expect(() => soundsOf({ sfx: [{ at: 1, sound: "boom" }] }, [], [], time)).toThrow(/no sound "boom"/);
  });
});

describe("the player's prologue", () => {
  const p: Prologue = {
    duration: 30,
    beats: [
      { type: "camera", start: 3, end: 12, layout: "follow", focus: [[3, 1], [6, 1], [7, 0]] },
      { type: "blink", at: [28, 29] },
    ],
  };

  test("the camera follows its keys while it lasts", () => {
    expect(cameraAt(p, 2)).toBeUndefined();
    expect(cameraAt(p, 4)).toEqual({ layout: "follow", focus: 1 });
    expect(cameraAt(p, 6.5)!.focus).toBeCloseTo(0.5);
    expect(cameraAt(p, 8)!.focus).toBe(0);
    expect(cameraAt(p, 12)).toBeUndefined();
    const lifted: Prologue = { duration: 30, beats: [{ type: "camera", start: 3, end: 12, layout: "follow", lift: [[6, 0], [7, 1.2]] }] };
    expect(cameraAt(lifted, 5)!.lift).toBe(0);
    expect(cameraAt(lifted, 6.5)!.lift).toBeCloseTo(0.6);
    expect(cameraAt(lifted, 9)!.lift).toBe(1.2);
  });

  test("the antenna's blinks, dark between them, its own outside", () => {
    expect(blinkAt(p, 20)).toBeNull();
    expect(blinkAt(p, 27.8)).toBe(0);
    expect(blinkAt(p, 28.16)).toBeCloseTo(1);
    expect(blinkAt(p, 28.6)).toBe(0);
    expect(blinkAt(p, 31)).toBeNull();
  });

  test("the clock eases through its keys without overshooting", () => {
    const keys: [number, number][] = [[0, 0], [2, 100], [3, 400], [5, 450]];
    expect(clockAt(keys, -1)).toBe(0);
    expect(clockAt(keys, 2)).toBe(100);
    expect(clockAt(keys, 9)).toBe(450);
    let last = 0;
    for (let t = 0; t <= 5; t += 0.01) {
      const v = clockAt(keys, t);
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      expect(v).toBeLessThanOrEqual(450);
      last = v;
    }
  });

  test("after the prologue the clock shows the recording's time, jumping at each trim", () => {
    const c = { type: "clock" as const, start: 10, land: 20, keys: [[10, 0], [20, 450]] as [number, number][], call: 451, cuts: [[60, 1]] as [number, number][] };
    expect(clockTime(c, 30, 20)).toBe(450);
    expect(clockTime(c, 30, 31)).toBe(452);
    expect(clockTime(c, 30, 59.5)).toBe(480.5);
    expect(clockTime(c, 30, 60)).toBe(482);
  });

  test("the message is typed over its stretch, an emoji one key", () => {
    const { chars, times } = keyTimes("AI 😄", [1, 2]);
    expect(chars).toEqual(["A", "I", " ", "😄"]);
    expect(times[0]).toBe(1);
    expect(times.at(-1)).toBe(2);
  });

  test("the song's banner comes `tease` s early, karaoke mode after it", () => {
    const song = { start: 40, tease: 1.25 };
    expect(songBanner(song, 38.7)).toBeNull();
    expect(songBanner(song, 38.75)).toMatchObject({ since: 0, badge: 0 });
    expect(songBanner(song, 38.75)!.banner).toBeCloseTo(0);
    expect(songBanner(song, 40)!.banner).toBeGreaterThan(0.9);
    expect(songBanner(song, 41.9)!.badge).toBe(0);
    expect(songBanner(song, 43)).toMatchObject({ banner: 0, badge: 1 });
    // no tease: at the song
    expect(songBanner({ start: 40 }, 39.9)).toBeNull();
  });
});

describe("the song's solos", () => {
  // 120 bpm: a beat is 0.5 s
  const lines = [
    { speaker: "caller", start: 10, end: 14 },
    { speaker: "caller", start: 14.6, end: 16 },
    { speaker: "both", start: 16, end: 20 },
    { speaker: "agent", start: 20, end: 22 },
  ];
  test("a line of their own steps them forward over a beat, back over a beat after it", () => {
    expect(soloAt(lines, 9.9, 120)).toEqual({ caller: 0, agent: 0 });
    expect(soloAt(lines, 10.25, 120).caller).toBeCloseTo(0.5);
    expect(soloAt(lines, 12, 120)).toEqual({ caller: 1, agent: 0 });
    // lines of theirs under two beats apart run together
    expect(soloAt(lines, 14.3, 120).caller).toBe(1);
    expect(soloAt(lines, 16.25, 120).caller).toBeCloseTo(0.5);
    // a line everyone sings is no one's
    expect(soloAt(lines, 18, 120)).toEqual({ caller: 0, agent: 0 });
    expect(soloAt(lines, 21, 120).agent).toBe(1);
  });
});

describe("the subtitles", () => {
  const l = (start: number, end: number) => ({ start, end });
  test("one line at a time, unless it's a quick exchange or cross-talk", () => {
    // a reply after a pause: alone
    expect(shownLines([l(0, 3), l(4, 6)], 4.5, 2)).toEqual([l(4, 6)]);
    // a quick follow-on (started within 2 s): both
    expect(shownLines([l(0, 1), l(1.5, 4)], 2, 2)).toEqual([l(0, 1), l(1.5, 4)]);
    // cross-talk: the earlier still being said when the next starts
    expect(shownLines([l(0, 5), l(3, 6)], 4, 2)).toEqual([l(0, 5), l(3, 6)]);
    // never more than max, and nothing after the linger
    expect(shownLines([l(0, 1), l(0.5, 1.5), l(1, 2)], 1.2, 2)).toHaveLength(2);
    expect(shownLines([l(0, 1)], 2.6, 2)).toEqual([]);
  });
});

describe("the song's build-up", () => {
  // 120 bpm (a beat 0.5 s), the song at 100 s
  const parts: [number, string][] = [[0, "verse"], [10, "chorus"], [20, "verse"], [30, "chorus"], [40, "bridge"], [50, "outro"], [60, "finale"]];
  const lines = [
    { speaker: "caller", start: 102, end: 106 },
    { speaker: "agent", start: 122, end: 123 },
    { speaker: "agent", start: 124, end: 128 },
    { speaker: "caller", start: 131, end: 136 },
    { speaker: "caller", start: 141, end: 143 },
    { speaker: "caller", start: 151, end: 155, solo: true },
  ];
  const at = (t: number) => stagingAt({ start: 100, bpm: 120, lines }, parts, t);
  test("solos only from the second verse, on strong lines, not in a chorus; a marked one whatever its length", () => {
    expect(at(104).solo.caller).toBe(0);
    expect(at(122.5).solo.agent).toBe(0);
    expect(at(126).solo.agent).toBe(1);
    expect(at(133).solo.caller).toBe(0);
    expect(at(153).solo.caller).toBe(1);
  });
  test("dancing free where nobody sings from the bridge, building; grooving in later choruses", () => {
    expect(at(140).free).toBe(0);
    expect(at(146).free).toBe(1);
    expect(at(146).freeMoves).toBeLessThan(at(149).freeMoves);
    expect(at(115).groove).toBe(0);
    expect(at(135).groove).toBeCloseTo(0.6);
    // not after the finale starts
    expect(at(162).free).toBe(0);
  });
  test("the bot gets up once, on its first strong solo (or a line marked stand), and stays up", () => {
    expect(at(124).stood).toBe(0);
    expect(at(125).stood).toBe(1);
    expect(at(160).stood).toBe(1);
    expect(stagingAt({ start: 100, bpm: 120, lines: [...lines, { speaker: "agent", start: 141, end: 142, stand: true }] }, parts, 140).stood).toBe(0);
    expect(stagingAt({ start: 100, bpm: 120, lines: [...lines, { speaker: "agent", start: 141, end: 142, stand: true }] }, parts, 142).stood).toBe(1);
  });
});

describe("moving the call's times", () => {
  test("trims: later times move up, those inside go to the cut", () => {
    const f = trimmer([[10, 11], [20, 20.5]]);
    expect([f(5), f(10.5), f(12), f(20.2), f(30)]).toEqual([5, 10, 11, 19, 28.5]);
    expect(() => trimmer([[3, 2]])).toThrow();
    expect(() => trimmer([[1, 5], [4, 6]])).toThrow();
  });

  test("trimmed samples: exactly that much shorter, crossfaded at the cut", () => {
    const rate = 1000;
    const x = new Float32Array(3000);
    x.fill(1, 0, 1000);
    x.fill(-1, 1000, 2000);
    x.fill(1, 2000);
    const y = trimSamples(x, rate, [[1, 2]], 0.1);
    expect(y.length).toBe(2000);
    // the second half is the third second, and the join moves from one to the other
    expect(y[100]).toBe(1);
    expect(y[1999]).toBe(1);
    expect(y[1100]).toBe(1);
    expect(y[950]).toBe(1);
  });

  test("everything after a prologue moves later: lines, beeps, verdicts, stages, the song", () => {
    const call = {
      lines: [{ speaker: "agent" as const, start: 0.07, end: 3, words: [[0.07, "Okay, "]] as [number, string][] }],
      beeps: [{ speaker: "caller" as const, start: 1, end: 1.5 }],
      verdicts: [[0, 0.8, 0, 0.1]] as [number, number, number, number][],
      stages: [[0, "waste_time"]] as [number, string][],
      song: { start: 40, end: 170, bpm: 116, beat: 40.3, tease: 1.25, lines: [{ speaker: "both" as const, start: 41, end: 42, words: [[41, "la "]] as [number, string][] }] },
    };
    const r = retime(call, (t) => t + 33.5);
    expect(r.lines[0]).toMatchObject({ start: 33.57, words: [[33.57, "Okay, "]] });
    expect(r.beeps[0]).toMatchObject({ start: 34.5, end: 35 });
    expect(r.verdicts[0]).toEqual([33.5, 0.8, 0, 0.1]);
    expect(r.stages[0]).toEqual([33.5, "waste_time"]);
    expect(r.song).toMatchObject({ start: 73.5, end: 203.5, beat: 73.8, tease: 1.25, lines: [{ start: 74.5, words: [[74.5, "la "]] }] });
  });
});
