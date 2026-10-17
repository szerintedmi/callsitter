// A demo's prologue (build.ts --prologue <prologue.json>): an opening before the call, from a
// storyboard. Its sound is built here (lines from the recording, cut to their words, and
// synthesized effects: sfx.ts), as loud as the call; its picture is the player's
// (src/web/client/listen-prologue.ts), from the beats written into the demo's JSON.
//
// prologue.json (private: it names stretches of the recording; keep it in data/demos/<slug>/)
//  {"words": "data/demos/<slug>/full",        transcribe.ts output for the whole recording (the
//                                             subtitles; the build's edits.json and rules apply)
//   "duration": "end",                        where the call starts
//   "marks": {"stage": "intro.end+0.6", …},   named times
//   "voice": [                                the lines heard, in the recording's seconds
//     {"id": "hello", "at": 3.35, "from": 3.12, "to": 3.78},           the bot's unless "speaker"
//     {"id": "intro", "at": "hello.end+1", "from": 15.47, "to": 18.8, "speaker": "caller"},
//     {"at": "land", "from": 436, "until": "back+0.6", "speaker": "both",   in the background (a
//      "gain": -22, "filter": "lowpass=f=1200", "fade": 0.5}],              "gain"): no subtitle, no
//                                                                            mouth; "both" sides;
//                                                                            "fadeIn"/"fadeOut" s;
//                                                                            "subs": [from, to] the
//                                                                            words to show, if not all
//   "offLimits": [{"speaker": "caller", "from": 0, "to": 14.8}, {"speaker": "caller", "from": 448.4}],
//                                             never to be used (names, an email): the build stops
//   "stages": [["stage", "waste_time"]],      call-flow stages entered in it: the player's banner
//   "mime": [{"speaker": "caller", "from": "lapse", "to": "back"}],   a mouth moving where nobody's heard
//   "sfx": [{"at": "steer", "sound": "hum", "until": "back", "gain": -22}],   more effects (sfx.ts)
//   "beats": [{"type": "card", "start": 3.45, "end": 5.7, "text": "My *AI bot* picks up.", "sound": "pop"}, …]}
//                                             listen-story.ts Beat, its times as below; a clock's
//                                             keys come from the lines in it ("from"/"to": call s)
//
// A time is seconds, or a name and an offset: "intro.end+0.6". Names: a line's id (its start) and
// <id>.end, the marks, "call" (the duration) and "song" (the call's song, on the published clock).
// The beats' sounds come with them (a ring's buzzes and pickup, a clock's ticks and landing, the
// phone's keys and send, the antenna's blips, a card's "sound").
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beatsOf, clamp01, clockAt, hash, keyTimes, type Beat, type Prologue } from "../../src/web/client/listen-story";
import { CHANNEL, ffmpeg, run, type Speaker } from "./audio";
import type { DemoLine } from "./build";
import { isSound, sourceOf, type Sfx } from "./sfx";

type When = number | string;
type Spoken = Speaker | "both";
/** a beat as written: listen-story.ts Beat, its times may be names, a clock's keys left out */
type SpecBeat = { type: Beat["type"] } & Record<string, unknown>;

export interface PrologueSpec {
  words: string;
  duration: When;
  marks?: Record<string, When>;
  voice: { id?: string; at: When; from: number; to?: number; until?: When; speaker?: Spoken; gain?: number; filter?: string; fade?: number; fadeIn?: number; fadeOut?: number; subs?: [number, number] }[];
  offLimits: { speaker: Speaker; from: number; to?: number }[];
  stages?: [When, string][];
  mime?: { speaker: Speaker; from: When; to: When }[];
  sfx?: { at: When; sound: string; gain?: number; until?: When }[];
  beats: SpecBeat[];
}

/** a line placed: `at` s on the prologue's clock, `from`–`to` s of the recording */
export interface Piece {
  id?: string;
  at: number;
  from: number;
  to: number;
  speaker: Spoken;
  gain?: number;
  filter?: string;
  fade?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** the stretch whose words make its subtitle (else its own) */
  subs?: [number, number];
}
const endOf = (p: Piece) => p.at + p.to - p.from;
const foreground = (p: Piece): p is Piece & { speaker: Speaker } => p.gain === undefined;

/** the voice's loudness, each side evened out (the call's mix is -16 LUFS) */
const VOICE_LUFS = -17;
/** a tick each time the clock passes this many seconds of the call, at these pitches in turn */
const TICK_EVERY = 5;
const TICK_PITCHES = [1047, 784, 880, 784];
const RATE = 48000;

/**
 * Resolves the spec's times: `time(x)` for seconds or "name±s". `song`: where the call's song
 * starts, on the call's clock (for "song"). Throws on an unknown name or a loop.
 */
export function timesOf(spec: Pick<PrologueSpec, "voice" | "marks" | "duration">, song?: number): (x: When) => number {
  const known = new Map<string, number>();
  const busy = new Set<string>();
  const name = (n: string): number => {
    if (known.has(n)) return known.get(n)!;
    if (busy.has(n)) throw new Error(`prologue: "${n}" depends on itself`);
    busy.add(n);
    let v: number;
    const [id, end] = n.endsWith(".end") ? [n.slice(0, -4), true] : [n, false];
    const line = spec.voice.find((l) => l.id === id);
    if (line) {
      const at = time(line.at);
      v = end ? at + (line.until !== undefined ? time(line.until) - at : line.to! - line.from) : at;
    } else if (!end && spec.marks && n in spec.marks) v = time(spec.marks[n]!);
    else if (n === "call") v = time(spec.duration);
    else if (n === "song") {
      if (song === undefined) throw new Error(`prologue: "song" but the call has no song`);
      v = time("call") + song;
    } else throw new Error(`prologue: no time named "${n}"`);
    busy.delete(n);
    known.set(n, v);
    return v;
  };
  const time = (x: When): number => {
    if (typeof x === "number") return x;
    const m = /^\s*([A-Za-z_][\w-]*(?:\.end)?)\s*(?:([+-])\s*(\d+(?:\.\d+)?))?\s*$/.exec(x);
    if (!m) throw new Error(`prologue: "${x}" isn't a time`);
    // to the ms: sums of decimals come out a hair off
    return Math.round((name(m[1]!) + (m[2] ? (m[2] === "-" ? -1 : 1) * Number(m[3]) : 0)) * 1000) / 1000;
  };
  return time;
}

/** The spec's lines placed, refusing any that touch the off-limits stretches. */
export function piecesOf(spec: Pick<PrologueSpec, "voice" | "offLimits">, time: (x: When) => number): Piece[] {
  return spec.voice.map((l) => {
    const at = time(l.at);
    const to = l.until !== undefined ? l.from + time(l.until) - at : l.to;
    if (to === undefined || !(to > l.from)) throw new Error(`prologue: the line at ${l.from} s needs "to" or "until" after it`);
    const p: Piece = { id: l.id, at, from: l.from, to, speaker: l.speaker ?? "agent", gain: l.gain, filter: l.filter, fade: l.fade, fadeIn: l.fadeIn, fadeOut: l.fadeOut, subs: l.subs };
    if (p.speaker === "both" && p.gain === undefined) throw new Error(`prologue: a line from both sides is a background one (needs "gain")`);
    for (const sp of sidesOf(p)) {
      const bad = spec.offLimits.find((o) => o.speaker === sp && p.from < (o.to ?? Infinity) && p.to > o.from);
      if (bad) throw new Error(`prologue: the ${sp} line at ${p.from}–${p.to} s touches the off-limits ${bad.from}–${bad.to ?? "end"} s`);
    }
    return p;
  });
}
const sidesOf = (p: Piece): Speaker[] => (p.speaker === "both" ? ["caller", "agent"] : [p.speaker]);

/** The beats with their times resolved, and a clock's keys from the lines inside it. */
export function beatsFrom(spec: Pick<PrologueSpec, "beats">, time: (x: When) => number, pieces: Piece[], callStart: number): Beat[] {
  const t = (x: unknown) => time(x as When);
  return spec.beats.map((b): Beat => {
    const s = { ...b } as Record<string, unknown>;
    for (const k of ["start", "end", "land", "answer", "sent", "handoff"]) if (s[k] !== undefined) s[k] = t(s[k]);
    if (Array.isArray(s.buzz)) s.buzz = s.buzz.map(t);
    if (Array.isArray(s.typing)) s.typing = s.typing.map(t);
    if (Array.isArray(s.at)) s.at = s.at.map(t);
    for (const k of ["focus", "lift"]) if (Array.isArray(s[k])) s[k] = (s[k] as [When, number][]).map(([w, v]) => [t(w), v]);
    if (s.caption) s.caption = { ...(s.caption as object), at: t((s.caption as { at: When }).at) };
    if (b.type === "clock") {
      // through `from` (call s) at its start, each line's middle at its own time, `to` as it lands
      const [start, land] = [s.start as number, s.land as number];
      const inside = pieces.filter((p) => foreground(p) && p.at >= start && p.at < land);
      s.keys = [[start, (b.from as number) ?? 0], ...inside.map((p) => [round((p.at + endOf(p)) / 2), round((p.from + p.to) / 2)]), [land, b.to as number]];
      s.call = callStart;
      delete s.from;
      delete s.to;
    }
    return s as unknown as Beat;
  });
}

/** The sounds: each beat's own, then the spec's. */
export function soundsOf(spec: Pick<PrologueSpec, "sfx">, beats: Beat[], pieces: Piece[], time: (x: When) => number): Sfx[] {
  const p: Prologue = { duration: 0, beats };
  const out: Sfx[] = [];
  const spoken = pieces.filter(foreground);
  for (const r of beatsOf(p, "ring")) {
    for (const at of r.buzz) out.push({ at, sound: "buzz", gain: -11 });
    out.push({ at: r.end, sound: "click", gain: -12 });
  }
  for (const c of beatsOf(p, "card")) if (c.sound) out.push({ at: c.start, sound: checked(c.sound), gain: -20 });
  for (const c of beatsOf(p, "clock")) {
    // a tick each time the clock passes TICK_EVERY s: a whirr where it races, a few where it slows for a line; softer under the lines
    let n = Math.floor(clockAt(c.keys, c.start) / TICK_EVERY);
    for (let t = c.start; t < c.land; t += 0.001) {
      const k = Math.floor(clockAt(c.keys, t) / TICK_EVERY);
      if (k <= n) continue;
      n = k;
      const talking = spoken.some((l) => t >= l.at - 0.05 && t < endOf(l));
      out.push({ at: t, sound: "tick", gain: talking ? -29 : -21, params: { hz: TICK_PITCHES[k % TICK_PITCHES.length] } });
    }
    const duck = spoken.filter((l) => l.at >= c.start && l.at < c.land).map((l): [number, number] => [l.at - c.start - 0.05, endOf(l) - c.start]);
    out.push({ at: c.start, sound: "bed", gain: -14, params: { d: c.land - c.start, duck } });
    out.push({ at: c.land, sound: "thump", gain: -9 });
  }
  for (const ph of beatsOf(p, "phone")) {
    keyTimes(ph.text, ph.typing).times.forEach((at, i) => out.push({ at, sound: "key", gain: -16 - 4 * hash(i + 7) }));
    out.push({ at: ph.sent, sound: "sent", gain: -14, params: { hz: 1319 } }, { at: ph.sent + 0.07, sound: "sent", gain: -14, params: { hz: 1760 } }, { at: ph.sent, sound: "whoosh", gain: -12 });
  }
  for (const b of beatsOf(p, "blink")) for (const at of b.at) out.push({ at, sound: "blip", gain: -12 });
  for (const s of spec.sfx ?? []) {
    const at = time(s.at);
    out.push({ at, sound: checked(s.sound), gain: s.gain ?? 0, ...(s.until !== undefined && { params: { d: time(s.until) - at } }) });
  }
  return out;
}
const checked = (name: string) => {
  if (!isSound(name)) throw new Error(`prologue: no sound "${name}" (demos/tools/sfx.ts)`);
  return name;
};

/** a mouth moving where nobody's heard: talking on and off, 0–1, at t */
export function mimeAt(t: number): number {
  const v = 0.62 + 0.3 * Math.sin(t * 13.7) * Math.sin(t * 4.1 + 1) + 0.12 * Math.sin(t * 29.3);
  // short breaths
  return hash(Math.floor(t * 2.5)) < 0.18 ? 0.1 : clamp01(v);
}

/** Each word as the build has it (fixed and redacted): `beep` if a rule beeps it out of the audio. */
export type Word = { speaker: Speaker; start: number; end: number; text: string; beep?: boolean };

export interface BuiltPrologue {
  prologue: Prologue;
  /** stereo, 48 kHz, interleaved, `duration` long, as loud as the call */
  audio: Float32Array;
  /** each side's foreground voice at the call's channel loudness (-20 LUFS), mono: the mouths */
  voice: Record<Speaker, Float32Array>;
  lines: DemoLine[];
  stages: [number, string][];
  /** where a mouth mimes: [speaker, from, to], minus where anyone's line plays */
  mime: { speaker: Speaker; from: number; to: number }[];
  /** the foreground lines' stretches, for the mime */
  spoken: [number, number][];
}

/**
 * Builds the prologue: its lines from `recording` (stereo: left the caller, right the bot), each
 * side evened to VOICE_LUFS and the background ones under that, the effects, all made as loud as
 * `callLufs`. `words`: the whole recording's words (fixed, redacted); a line holding a beeped word
 * stops the build (pick another stretch). `song`: the call's song start, on its clock.
 */
export async function buildPrologue(spec: PrologueSpec, o: { recording: string; words: Word[]; callLufs: number; callStart: number; song?: number; levelFps: number }): Promise<BuiltPrologue> {
  const time = timesOf(spec, o.song);
  // whole frames of the mouths' levels, so the call's start on with them
  const duration = Math.round(time(spec.duration) * o.levelFps) / o.levelFps;
  const pieces = piecesOf(spec, time);
  for (const p of pieces) {
    const beeped = o.words.find((w) => sidesOf(p).includes(w.speaker) && w.beep && w.end > p.from && w.start < p.to);
    if (beeped) throw new Error(`prologue: the line at ${p.from}–${p.to} s holds a redacted word (${beeped.start} s): pick another stretch`);
    if (endOf(p) > duration + 1e-6) throw new Error(`prologue: the line at ${p.from} s runs past its end (${endOf(p).toFixed(2)} > ${duration})`);
  }
  const beats = beatsFrom(spec, time, pieces, o.callStart);
  const sfx = soundsOf(spec, beats, pieces, time);
  const work = mkdtempSync(join(tmpdir(), "prologue-"));
  try {
    // each side's foreground at unity: its loudness, and its mouth (at the call's -20 LUFS a side)
    const gain: Partial<Record<Speaker, number>> = {};
    const voice = {} as Record<Speaker, Float32Array>;
    for (const sp of ["caller", "agent"] as const) {
      const mine = pieces.filter((p) => sidesOf(p).includes(sp));
      const fore = mine.filter(foreground);
      voice[sp] = new Float32Array(Math.round(duration * RATE));
      if (!mine.length) continue;
      const solo = join(work, `voice-${sp}.wav`);
      await lay(o.recording, (fore.length ? fore : mine).map((p) => ({ ...p, side: sp, db: 0 })), duration, solo);
      const lufs = await loudness(solo);
      gain[sp] = VOICE_LUFS - lufs;
      if (fore.length) voice[sp] = await samples(solo, 1, `volume=${(-20 - lufs).toFixed(2)}dB`);
    }
    const voiceWav = join(work, "voice.wav");
    await lay(o.recording, pieces.flatMap((p) => sidesOf(p).map((side) => ({ ...p, side, db: gain[side]! + (p.gain ?? 0) }))), duration, voiceWav);
    const mix = await withSfx(voiceWav, sfx, duration, join(work, "mix.wav"));
    const mine = await loudness(mix);
    const audio = await samples(mix, 2, `volume=${(o.callLufs - mine).toFixed(2)}dB,alimiter=limit=0.89:level=disabled`);
    console.log(`prologue: ${duration.toFixed(2)} s, ${pieces.length} lines, ${sfx.length} sounds; ${mine.toFixed(1)} LUFS, to the call's ${o.callLufs.toFixed(1)}`);
    const spoken = pieces.filter(foreground);
    return {
      prologue: { duration, beats },
      audio: fit(audio, Math.round(duration * RATE) * 2),
      voice: { caller: fit(voice.caller, Math.round(duration * RATE)), agent: fit(voice.agent, Math.round(duration * RATE)) },
      lines: spoken.map((p) => lineOf(p, o.words)).filter((l) => l.words.length).sort((a, b) => a.start - b.start),
      stages: (spec.stages ?? []).map(([w, s]) => [round(time(w)), s]),
      mime: (spec.mime ?? []).map((m) => ({ speaker: m.speaker, from: time(m.from), to: time(m.to) })),
      spoken: spoken.map((p) => [p.at, endOf(p)]),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** a foreground line's subtitle: the words heard in it (Whisper's starts run a little early), on the prologue's clock */
function lineOf(p: Piece & { speaker: Speaker }, words: Word[]): DemoLine {
  const [from, to] = p.subs ?? [p.from, p.to];
  const ws = words.filter((w) => w.speaker === p.speaker && w.text && w.end > from + 0.12 && w.start < to - 0.08).sort((a, b) => a.start - b.start);
  const out: [number, string][] = ws.map((w, i) => {
    // a line cut from mid-sentence starts with a capital
    const text = i ? w.text : w.text.charAt(0).toUpperCase() + w.text.slice(1);
    return [round(p.at + Math.max(0, w.start - p.from)), text];
  });
  const end = Math.min(endOf(p), p.at + (ws.at(-1)?.end ?? p.to) - p.from);
  return { speaker: p.speaker, start: out[0]?.[0] ?? round(p.at), end: round(end), words: out };
}

/** after adelay: the samples count from 0 again (a stretch cut from the recording keeps its times, and amix goes by them) */
const RETIME = "asetpts=N/SR/TB";

/** `pieces` (each from its `side` at `db` dB, with short fades) on the clock, mono, into `out` */
async function lay(recording: string, pieces: (Piece & { side: Speaker; db: number })[], duration: number, out: string) {
  const chains = pieces.map((l, i) => {
    const len = l.to - l.from;
    const fadeIn = Math.min(len, l.fadeIn ?? l.fade ?? 0.012);
    const fadeOut = Math.min(len, l.fadeOut ?? l.fade ?? 0.03);
    return `[a${i}]pan=mono|c0=c${CHANNEL[l.side]},aresample=${RATE},atrim=start=${l.from}:end=${l.to},asetpts=PTS-STARTPTS,` +
      `afade=t=in:d=${fadeIn},afade=t=out:st=${Math.max(0, len - fadeOut)}:d=${fadeOut},${l.filter ? `${l.filter},` : ""}` +
      `volume=${l.db.toFixed(2)}dB,adelay=${Math.round(l.at * 1000)}:all=1,${RETIME}[v${i}]`;
  });
  const graph = [`[0:a]asplit=${pieces.length}${pieces.map((_, i) => `[a${i}]`).join("")}`, ...chains,
    `${pieces.map((_, i) => `[v${i}]`).join("")}amix=inputs=${pieces.length}:normalize=0:dropout_transition=0,apad,atrim=end=${duration}[out]`].join(";");
  await ffmpeg(["-i", recording, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_f32le", out]);
}

/** the voice and the effects (each source rendered once, placed where it's used), stereo, into `out` */
async function withSfx(voiceWav: string, sfx: Sfx[], duration: number, out: string): Promise<string> {
  const srcs = [...new Set(sfx.map(sourceOf))];
  const inputs = ["-i", voiceWav, ...srcs.flatMap((src) => ["-f", "lavfi", "-i", src])];
  const graph: string[] = ["[0:a]anull[voice]"];
  const placed: string[] = ["[voice]"];
  srcs.forEach((src, j) => {
    const uses = sfx.filter((s) => sourceOf(s) === src);
    graph.push(`[${j + 1}:a]aresample=${RATE},asplit=${uses.length}${uses.map((_, k) => `[x${j}_${k}]`).join("")}`);
    uses.forEach((s, k) => {
      graph.push(`[x${j}_${k}]volume=${s.gain}dB,adelay=${Math.round(s.at * 1000)}:all=1,${RETIME}[y${j}_${k}]`);
      placed.push(`[y${j}_${k}]`);
    });
  });
  graph.push(`${placed.join("")}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad,atrim=end=${duration},pan=stereo|c0=c0|c1=c0[out]`);
  await ffmpeg([...inputs, "-filter_complex", graph.join(";"), "-map", "[out]", "-ar", String(RATE), "-c:a", "pcm_f32le", out]);
  return out;
}

/** integrated loudness, LUFS: of a file, or of raw samples on stdin (file "-", their format in `input`) */
export async function loudness(file: string, input: string[] = [], stdin?: Float32Array): Promise<number> {
  const { stderr } = await run(["ffmpeg", "-hide_banner", ...input, "-i", file, "-af", "ebur128", "-f", "null", "-"], stdin && { stdin: new Uint8Array(stdin.buffer, stdin.byteOffset, stdin.byteLength) });
  const i = stderr.match(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/);
  if (!i) throw new Error(`no loudness for ${file}`);
  return Number(i[1]);
}

/** a file's samples, `channels` interleaved at RATE, through `af` */
async function samples(file: string, channels: number, af: string): Promise<Float32Array> {
  const { stdout } = await ffmpeg(["-i", file, "-af", af, "-ac", String(channels), "-ar", String(RATE), "-f", "f32le", "-"]);
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4).slice();
}

/** exactly `n` samples: cut, or padded with silence */
function fit(x: Float32Array, n: number): Float32Array {
  if (x.length === n) return x;
  const out = new Float32Array(n);
  out.set(x.subarray(0, n));
  return out;
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}
