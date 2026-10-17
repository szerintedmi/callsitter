// A demo's prologue: an opening before the call (a phone ringing, the pickup, a time-lapse, the
// owner steering the bot from their phone), as its storyboard of beats on the published clock. The
// build (demos/tools/build.ts --prologue) writes it into demos/calls/<slug>.json `prologue` and its
// sound into the published audio; the player draws it (listen-prologue.ts). Pure (no DOM, no Bun):
// the build times the sounds with the same functions the page draws with.
/** the scene's layouts (listen-scene.ts Layout; not imported, so the build can use this file) */
type Layout = "wide" | "stack" | "follow";

/** what the player gets: every time is on the published clock (the prologue starts at 0, the call at `duration`) */
export interface Prologue {
  /** where the call starts */
  duration: number;
  beats: Beat[];
}

/**
 * The beats. Cards: *…* in amber, \n a new line; `pos` is the middle's height (0–1).
 * ring: black, the owner's phone ringing with the caller ID on it, a soft siren wash; the answer button pressed at `answer`
 * camera: the scene's layout for a while (follow: one camera, `focus` keys from 1 the bot to 0 the caller,
 *   `lift` keys raising it: headroom)
 * tag: a small label in the top-left corner
 * clock: the call's time racing through `keys` ([t, call s]) and landing; after the prologue the call's own, from `call` s,
 *   jumping ahead where the call was trimmed (`cuts`: [t, s cut])
 * dim: the scene darkened (`amount` 0–1)
 * a card or dim with `clear`: the player's subtitles and badge off while it's up; a card with `in: "none"` is
 *   there at once (no pop), one with `follow` has its middle on that side's eye line (`pos` then unused)
 * phone: the owner's chat with the bot, coming up from below: the message typed, sent, then shrunk to `pos` at `handoff`
 * blink: the bot's antenna lighting up at each time (it got the message)
 */
export type Beat =
  | { type: "ring"; start: number; end: number; id: string; label?: string; caption?: { at: number; text: string }; buzz: number[]; answer: number }
  | { type: "camera"; start: number; end: number; layout: Layout; focus?: [number, number][]; lift?: [number, number][] }
  | { type: "card"; start: number; end: number; text: string; sub?: string; pos?: number; size?: number; align?: "left"; sound?: string; clear?: boolean; in?: "pop" | "none"; follow?: "agent" | "caller" }
  | { type: "tag"; start: number; end: number; text: string }
  | { type: "clock"; start: number; land: number; end?: number; keys: [number, number][]; label?: string; call?: number; cuts?: [number, number][] }
  | { type: "dim"; start: number; end: number; amount?: number; clear?: boolean }
  | { type: "phone"; start: number; end: number; typing: [number, number]; sent: number; handoff: number; text: string; chat?: string; sender?: string; pos?: number }
  | { type: "blink"; at: number[] };

export type BeatOf<K extends Beat["type"]> = Extract<Beat, { type: K }>;
export const beatsOf = <K extends Beat["type"]>(p: Prologue, type: K): BeatOf<K>[] => p.beats.filter((b): b is BeatOf<K> => b.type === type);

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const easeInOut = (x: number) => {
  const u = clamp01(x);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};
/** deterministic noise in [0, 1) */
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * The clock's call seconds at t: through each key ([t, call s]), monotone cubic between them
 * (Fritsch–Carlson), flat at both ends, so it eases in, races between the keys and eases out.
 */
export function clockAt(keys: [number, number][], t: number): number {
  const k = keys;
  if (!k.length) return 0;
  if (t <= k[0]![0]) return k[0]![1];
  if (t >= k.at(-1)![0]) return k.at(-1)![1];
  const d = k.slice(1).map(([x, y], i) => (y - k[i]![1]) / (x - k[i]![0]));
  // the harmonic mean of the slopes either side keeps it from overshooting
  const m = k.map((_, i) => (i === 0 || i === k.length - 1 || d[i - 1]! * d[i]! <= 0 ? 0 : 2 / (1 / d[i - 1]! + 1 / d[i]!)));
  let i = 0;
  while (t > k[i + 1]![0]) i++;
  const [x0, y0] = k[i]!;
  const [x1, y1] = k[i + 1]!;
  const h = x1 - x0;
  const s = (t - x0) / h;
  return (2 * s ** 3 - 3 * s ** 2 + 1) * y0 + (s ** 3 - 2 * s ** 2 + s) * h * m[i]! + (-2 * s ** 3 + 3 * s ** 2) * y1 + (s ** 3 - s ** 2) * h * m[i + 1]!;
}

/** the message's characters (an emoji is one) and when each is typed: evenly over `typing`, with a little jitter */
export function keyTimes(text: string, [a, b]: [number, number]): { chars: string[]; times: number[] } {
  const chars = [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
  const step = (b - a) / Math.max(1, chars.length - 1);
  return { chars, times: chars.map((_, i) => a + i * step + (i > 0 && i < chars.length - 1 ? (hash(i) - 0.5) * 0.4 * step : 0)) };
}

/** a value through keys ([t, v]), eased between them, held at both ends */
export function keyed(keys: [number, number][], t: number): number {
  if (!keys.length) return 0;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]![0] <= t) i++;
  const [t0, v0] = keys[i]!;
  const next = keys[i + 1];
  if (!next || t <= t0) return v0;
  return v0 + (next[1] - v0) * easeInOut((t - t0) / (next[0] - t0));
}

/** the camera the prologue asks for at t, if any */
export function cameraAt(p: Prologue, t: number): { layout: Layout; focus?: number; lift?: number } | undefined {
  const c = beatsOf(p, "camera").find((b) => t >= b.start && t < b.end);
  return c && { layout: c.layout, focus: c.focus ? keyed(c.focus, t) : undefined, lift: c.lift ? keyed(c.lift, t) : undefined };
}

/** the antenna's blink at t: 0–1 lit, 0 between blinks once they've started, null outside them (the bot's own blinking) */
export function blinkAt(p: Prologue, t: number): number | null {
  const at = beatsOf(p, "blink").flatMap((b) => b.at);
  if (!at.length || t < Math.min(...at) - 0.45 || t > Math.max(...at) + 0.6) return null;
  return Math.max(0, ...at.map((b) => (t >= b && t < b + 0.32 ? Math.sin(((t - b) / 0.32) * Math.PI) : 0)));
}

/** a bounce in from 0 to 1 over `d` seconds (the player's) */
export function pop(s: number, d = 0.45): number {
  const x = clamp01(s / d);
  return x >= 1 ? 1 : 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
}
/** a banner's scale `s` s after it starts: in with a bounce, held, gone by 3.5 s */
export const bannerScale = (s: number) => (s < 0 || s > 3.5 ? 0 : s > 3.1 ? (3.5 - s) / 0.4 : pop(s));
/** when a badge takes over from its banner, s after it */
export const BADGE_AFTER = 3.3;

/**
 * The song's banner (listen.ts): it comes in `tease` s before the song, as the call says goodbye,
 * and karaoke mode's badge after it. Its scale and the badge's at t, `since` its start; null before.
 */
export function songBanner(song: { start: number; tease?: number }, t: number): { since: number; banner: number; badge: number } | null {
  const since = t - (song.start - (song.tease ?? 0));
  return since < 0 ? null : { since, banner: bannerScale(since), badge: since < BADGE_AFTER ? 0 : pop(since - BADGE_AFTER) };
}

/** the clock's call seconds at t: racing through its keys, then the call's own (the recording's, so it jumps at each trim) */
export function clockTime(c: BeatOf<"clock">, callStarts: number, t: number): number {
  if (t < callStarts || c.call === undefined) return clockAt(c.keys, t);
  return c.call + t - callStarts + (c.cuts ?? []).filter(([at]) => at <= t).reduce((n, [, s]) => n + s, 0);
}

/** Whether a `clear` card or dim is up at t (the subtitles and badge off), and how long since the last one went (to bring the badge back), or null. */
export function clearAt(p: Prologue, t: number): { on: boolean; since: number | null } {
  const cs = p.beats.filter((b): b is BeatOf<"card"> | BeatOf<"dim"> => (b.type === "card" || b.type === "dim") && !!b.clear);
  const on = cs.some((b) => t >= b.start && t < b.end);
  const ended = cs.map((b) => b.end).filter((e) => e <= t);
  return { on, since: on || !ended.length ? null : t - Math.max(...ended) };
}

type StageLine = { speaker: string; start: number; end: number; solo?: boolean; stand?: boolean };
const smoothstep = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/**
 * Who's singing a line of their own, 0–1 each: in over a beat (`beats`) from its start, out over as
 * long after (lines of theirs under two beats apart run together); a line everyone sings is no one's.
 * With `from`/`min`: only lines from `from` s on, in stretches at least `min` s long (or marked `solo`),
 * none starting in the `not` stretches.
 */
export function soloAt(lines: StageLine[], t: number, bpm: number, beats = 1, o: { from?: number; min?: number; not?: [number, number][] } = {}): { caller: number; agent: number } {
  const b = (60 / bpm) * beats;
  const out = { caller: 0, agent: 0 };
  for (const who of ["caller", "agent"] as const) {
    const spans: [number, number, boolean][] = [];
    for (const l of lines.filter((l) => l.speaker === who && l.start >= (o.from ?? -Infinity) && !(o.not ?? []).some(([a, z]) => l.start >= a && l.start < z))) {
      const last = spans.at(-1);
      if (last && l.start - last[1] < (2 * 60) / bpm) {
        last[1] = Math.max(last[1], l.end);
        last[2] ||= !!l.solo;
      } else spans.push([l.start, l.end, !!l.solo]);
    }
    for (const [a, z, flagged] of spans) {
      if (!flagged && z - a < (o.min ?? 0)) continue;
      out[who] = Math.max(out[who], Math.min(smoothstep((t - a) / b), smoothstep((z + b - t) / b)));
    }
  }
  return out;
}

/** a song's parts: [s into the song it starts, its name], in order */
export type Parts = [number, string][];

/**
 * How the song's staged at t (s on the published clock), building toward its finale: solos only on
 * strong lines (`soloMin` s or longer, or marked) from `soloFrom` (default: the second verse); from
 * `danceFrom` (default: the bridge) until the dancing together, dancing free in their own rooms
 * wherever nobody sings for `freeBeats` beats, more the longer it goes on; and grooving in place
 * through every chorus after the first. The bot (seated) gets up once (`stood`), on a line marked
 * `stand`, else its first strong solo, and stays up.
 */
export function stagingAt(
  song: { start: number; bpm: number; lines: StageLine[]; soloFrom?: number; soloMin?: number; danceFrom?: number },
  parts: Parts,
  t: number,
  o: { together?: string; freeBeats?: number } = {},
): { solo: { caller: number; agent: number }; soloCam: { caller: number; agent: number }; free: number; freeMoves: number; groove: number; stood: number } {
  const b = 60 / song.bpm;
  const since = t - song.start;
  const nth = (name: string, n: number) => parts.filter(([, s]) => s === name)[n]?.[0];
  const soloFrom = song.start + (song.soloFrom ?? nth("verse", 1) ?? 0);
  const danceFrom = song.start + (song.danceFrom ?? nth("bridge", 0) ?? Infinity);
  const togetherAt = song.start + (nth(o.together ?? "finale", 0) ?? Infinity);
  // the choruses are everyone's: no solos in them
  const sections = parts.map(([at, s], i) => [song.start + at, s, song.start + (parts[i + 1]?.[0] ?? Infinity)] as const);
  const solos = { from: soloFrom, min: song.soloMin ?? 2.5, not: sections.filter(([, s]) => s === "chorus").map(([a, , z]): [number, number] => [a, z]) };
  // free: the gaps with no line at all, at least freeBeats long, between danceFrom and the dancing together
  let free = 0;
  let freeMoves = 0;
  const gaps: [number, number][] = [];
  let cursor = danceFrom;
  for (const l of [...song.lines].sort((x, y) => x.start - y.start)) {
    if (l.end <= danceFrom) continue;
    if (Math.min(l.start, togetherAt) - cursor >= (o.freeBeats ?? 4) * b) gaps.push([cursor, Math.min(l.start, togetherAt)]);
    cursor = Math.max(cursor, l.end);
  }
  if (togetherAt - cursor >= (o.freeBeats ?? 4) * b && Number.isFinite(togetherAt)) gaps.push([cursor, togetherAt]);
  for (const [a, z] of gaps) {
    if (t < a || t > z) continue;
    // building as it goes on, back to their places a beat before the next line
    const there = Math.min(smoothstep((t - a) / b), smoothstep((z - t) / b));
    free = Math.max(free, there);
    freeMoves = Math.max(freeMoves, there * (0.55 + 0.45 * smoothstep((t - a) / (8 * b))));
  }
  // the bot gets up once, for good: on a line marked `stand`, else its first strong solo (two beats to get up)
  const standLine =
    song.lines.find((l) => l.stand) ??
    song.lines.find((l) => l.speaker === "agent" && l.start >= solos.from && !solos.not.some(([a, z]) => l.start >= a && l.start < z) && (l.solo || l.end - l.start >= solos.min));
  const stood = standLine ? smoothstep((t - standLine.start) / (2 * b)) : 0;
  // grooving in place: every chorus after the first
  let groove = 0;
  const choruses = parts.map(([at, s], i) => [at, s, parts[i + 1]?.[0] ?? Infinity] as const).filter(([, s]) => s === "chorus");
  for (const [a, , z] of choruses.slice(1)) groove = Math.max(groove, 0.6 * Math.min(smoothstep((since - a) / b), smoothstep((z - since) / b)));
  return { solo: soloAt(song.lines, t, song.bpm, 1, solos), soloCam: soloAt(song.lines, t, song.bpm, 3, solos), free, freeMoves, groove, stood };
}

/** a line's subtitle stays this long after its end */
export const SUB_LINGER = 1.5;
/** an earlier line stays up under a new one only if the new one came this soon after it started */
export const SUB_HOLD = 2;

/**
 * The subtitles up at t (lines in order of their starts): the latest line, and under it the ones
 * before it (up to `max` in all) only while they're part of a quick exchange: the next one started
 * within SUB_HOLD s of it, or while it was still being said (cross-talk). A reply after a pause
 * shows alone.
 */
export function shownLines<L extends { start: number; end: number }>(lines: L[], t: number, max: number): L[] {
  const live = lines.filter((l) => l.start <= t && t < l.end + SUB_LINGER);
  const out = live.slice(-1);
  for (let i = live.length - 2; i >= 0 && out.length < max; i--) {
    const prev = live[i]!;
    const next = out[0]!;
    if (next.start - prev.start < SUB_HOLD || prev.end > next.start) out.unshift(prev);
    else break;
  }
  return out;
}

// ---------- the player's fullscreen (listen-fullscreen.ts): what each event does ----------

export type FsBy = "button" | "rotate";
export interface FsState {
  on: boolean;
  by: FsBy | null;
  /** a history entry of ours is on top */
  pushed: boolean;
}
export type FsEvent =
  | { type: "button" }
  | { type: "rotate"; landscape: boolean; playing: boolean; touch: boolean }
  | { type: "escape" }
  | { type: "back" }
  | { type: "native-exit" };
/** enter/exit the fullscreen, push/pop our history entry, lock the screen to landscape */
export type FsEffect = "enter" | "exit" | "push" | "pop" | "lock";

export const FS_OFF: FsState = { on: false, by: null, pushed: false };

/**
 * What an event does. The button toggles (and asks for landscape); a phone turned to landscape while
 * playing enters, back to portrait leaves; Escape, the browser leaving its fullscreen and Back
 * leave. Leaving pops our history entry, unless Back already did. A desktop never rotates in.
 */
export function fsStep(s: FsState, e: FsEvent): { state: FsState; effects: FsEffect[] } {
  const exit = (popped = false): { state: FsState; effects: FsEffect[] } => ({
    state: FS_OFF,
    effects: ["exit", ...(s.pushed && !popped ? (["pop"] as const) : [])],
  });
  switch (e.type) {
    case "button":
      return s.on ? exit() : { state: { on: true, by: "button", pushed: true }, effects: ["enter", "push", "lock"] };
    case "rotate":
      if (!e.touch) return { state: s, effects: [] };
      if (e.landscape && e.playing && !s.on) return { state: { on: true, by: "rotate", pushed: true }, effects: ["enter", "push"] };
      if (!e.landscape && s.on) return exit();
      return { state: s, effects: [] };
    case "escape":
    case "native-exit":
      return s.on ? exit() : { state: s, effects: [] };
    case "back":
      return s.on ? exit(true) : { state: s, effects: [] };
  }
}
