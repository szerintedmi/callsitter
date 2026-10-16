// Builds a demo call (demos/calls/<slug>.json + .mp3) from a recording and its transcript
// (transcribe.ts): names and personal details beeped out of the audio and [redacted] in the text,
// loudness normalized per channel and overall.
//
//   bun demos/tools/build.ts <slug> --wav <recording.wav> --words <dir> --redact <rules.json> [--db <db> --call <id>]
//                            [--from <sec>] [--end <sec>] [--song <song.mp3> --lyrics <lyrics.json>] [--preview]
//
// --from/--end take a clip of the recording (seconds on its clock, like the words, fixes and beeps);
// the audio still opens LEAD_IN before the clip's first agent word, if that's after --from.
//
// <dir> holds transcribe.ts's output and, optionally, edits.json (below). Both files and the rules
// name the people they redact, so they stay out of the repo (keep them under data/, gitignored).
//
// rules.json  {"rules": [{"tokens": ["alice"], "show": "<her name>"},       a word, matched whole
//                         {"tokens": ["alicesmith"], "keepTail": 2},        shown as ********th
//                         {"tokens": ["s", "z", "e"], "mask": true}],       a run of words, as *-*-*
//              ("beep": false on a rule redacts the transcript only)
//              "watch": "pet|gmail"}    --preview flags lines matching this, to check by hand
// edits.json  {"fixes": [{"speaker": "caller", "from": 3.2, "to": 5.3, "text": "Hello, am I through to [redacted] there?"}],
//              "beeps": [{"speaker": "caller", "from": 4.5, "to": 5.0}],
//              "replace": [["Bodafire", "bona fide"]]}
//             fixes replace the words starting in [from, to) (Whisper misheard them; "" drops them);
//             beeps add a beep where a rule can't find the word; replace swaps a misheard word's
//             text wherever it occurs.
//
// --db/--call add Jev's verdicts and the call-flow stages from a copy of the database (bun run prod
// get-db), shifted onto the recording's clock by the agent's first words (with --from: by the clip's
// first agent line, found by its text). Verdicts from before the clip: only the last, at 0; stages
// entered before it start at 0.
//
// --song/--lyrics append a song after the call (SONG_GAP of silence, then the song as it is, not
// normalized) with karaoke lines in the JSON's `song`:
// lyrics.json {"bpm": 115.4, "beat": 0.23,          tempo, and the first beat (s into the song)
//              "lines": [{"speaker": "both", "text": "Who's the human? Who's the machine?"}, …]}
//             the lines in order, as sung ("caller", "agent" or "both"). Next to it, song.words.json:
//             Whisper's verbose_json of the song with word timings ({"words": [{word, start, end}]}).
//             Each lyric word gets the time of the Whisper word it's aligned
//             with (the lyric's spelling wins; a word Whisper split or missed is placed between).
//             Over the song, levels.music is the song's loudness, caller/agent the same gated by who
//             sings the current line.
//
// --preview prints the transcript with its beeps and writes no files.
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { SPEAKERS, channelSamples, envelope, ffmpeg, type Speaker } from "./audio";
import type { Word } from "./transcribe";

interface Rule {
  tokens: string[];
  show?: string;
  keepTail?: number;
  mask?: boolean;
  /** false: redact the transcript only, leave the audio */
  beep?: boolean;
}
interface Edits {
  fixes?: { speaker: Speaker; from: number; to: number; text: string }[];
  beeps?: { speaker: Speaker; from: number; to: number }[];
  replace?: [string, string][];
}
export interface DemoLine {
  speaker: Speaker;
  start: number;
  end: number;
  /** each word's start (s) and text, its punctuation and trailing space included */
  words: [number, string][];
}
export interface DemoCall {
  duration: number;
  lines: DemoLine[];
  beeps: { speaker: Speaker; start: number; end: number }[];
  /** speech level per speaker, LEVEL_FPS values a second (0–255), base64: drives the mouths; music: the song's */
  levels: Record<Speaker, string> & { music?: string };
  levelFps: number;
  /** Jev's verdict probabilities as the call went on: [t, scam, spam, genuine] */
  verdicts: [number, number, number, number][];
  /** call-flow stages entered: [t, stage] */
  stages: [number, string][];
  /** a song after the call (--song): where it plays, its tempo (beat: the first beat's time) and karaoke lines */
  song?: { start: number; end: number; bpm: number; beat: number; lines: SongLine[] };
}
export interface SongLine {
  speaker: Speaker | "both";
  start: number;
  end: number;
  words: [number, string][];
}

const RATE = 48000;
const LEVEL_FPS = 30;
/** a new line after a pause this long, or after a sentence once a line has this many words */
const LINE_GAP = 0.8;
const LINE_WORDS = 30;
/** beeps reach this much past the pauses they're snapped to (snapBeep) */
const BEEP_PAD = 0.03;
/** the audio starts this long before the bot's first word */
const LEAD_IN = 0.35;
const SNAP_FRAME = 0.01;
/** loudness per channel before mixing, and of the final mix (LUFS) */
const CHANNEL_LUFS = -20;
const FINAL_LUFS = -16;
/** how much of each speaker leaks to the other side: 0 hard-panned, 1 mono */
const SPREAD = 0.3;
const BEEP_HZ = 1000;
const BEEP_GAIN = 0.18;
/** silence between the call and the song */
const SONG_GAP = 0.8;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { wav: { type: "string" }, words: { type: "string" }, redact: { type: "string" }, db: { type: "string" }, call: { type: "string" }, from: { type: "string" }, end: { type: "string" }, song: { type: "string" }, lyrics: { type: "string" }, preview: { type: "boolean" } },
  allowPositionals: true,
});
const slug = positionals[0];
if (!slug || !values.wav || !values.words || !values.redact) throw new Error("usage: build.ts <slug> --wav <wav> --words <dir> --redact <rules.json> [--from <sec>] [--end <sec>] [--song <mp3> --lyrics <json>] [--preview]");
if (!values.song !== !values.lyrics) throw new Error("--song and --lyrics go together");
const endSec = values.end ? Number(values.end) : undefined;
const fromSec = Number(values.from ?? 0);
const { rules, watch } = (await Bun.file(values.redact).json()) as { rules: Rule[]; watch?: string };
const editsFile = Bun.file(`${values.words}/edits.json`);
const edits: Edits = (await editsFile.exists()) ? await editsFile.json() : {};

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

type Timed = Word & { speaker: Speaker; beep?: boolean };
const words: Timed[] = [];
for (const speaker of SPEAKERS) {
  let ws: Timed[] = ((await Bun.file(`${values.words}/${speaker}.words.json`).json()) as Word[]).map((w) => ({ ...w, speaker }));
  for (const f of (edits.fixes ?? []).filter((f) => f.speaker === speaker)) {
    const inside = ws.filter((w) => w.start >= f.from && w.start < f.to);
    const at = inside[0]?.start ?? f.from;
    const until = inside.at(-1)?.end ?? f.to;
    const parts = f.text.split(/(?<=\s)(?=\S)/).filter(Boolean);
    const fixed = parts.map((text, i) => ({
      speaker,
      word: norm(text),
      text: /\s$/.test(text) ? text : `${text} `,
      start: at + ((until - at) * i) / parts.length,
      end: at + ((until - at) * (i + 1)) / parts.length,
    }));
    ws = [...ws.filter((w) => !inside.includes(w)), ...fixed].sort((a, b) => a.start - b.start);
  }
  for (const w of ws) {
    const r = (edits.replace ?? []).find(([from]) => w.text.trim().replace(/[.,?!]+$/, "") === from);
    if (r) w.text = w.text.replace(r[0], r[1]);
  }
  words.push(...ws.filter((w) => w.start >= fromSec && w.start < (endSec ?? Infinity)));
}

// Redaction: rules over each speaker's words in order.
const beeps: DemoCall["beeps"] = [];
for (const speaker of SPEAKERS) {
  const ws = words.filter((w) => w.speaker === speaker);
  for (let i = 0; i < ws.length; i++) {
    for (const r of rules) {
      const run = ws.slice(i, i + r.tokens.length);
      if (run.length < r.tokens.length || !run.every((w, k) => new RegExp(`^(${r.tokens[k]})$`).test(norm(w.word)))) continue;
      for (const w of run) w.beep = r.beep !== false;
      if (r.show !== undefined && run.length > 1) {
        // a label stands for the whole run ("<my full name>"), keeping the last word's punctuation
        const last = run.at(-1)!;
        const tail = redactText(last, { ...r, show: "" });
        run[0]!.text = redactText(run[0]!, r).trimEnd() + tail.trimStart();
        for (const w of run.slice(1)) w.text = "";
      } else for (const w of run) w.text = redactText(w, r);
      i += r.tokens.length - 1;
      break;
    }
  }
  const env = envelope(await channelSamples(values.wav, speaker, 16000, endSec, fromSec), 16000, SNAP_FRAME);
  for (const w of ws.filter((w) => w.beep)) {
    const b = snapBeep(env, w.start - fromSec, w.end - fromSec);
    beeps.push({ speaker, start: b.start + fromSec, end: b.end + fromSec });
  }
}
beeps.push(...(edits.beeps ?? []).map((b) => ({ speaker: b.speaker, start: b.from, end: b.to })));
// The recording starts with ringing and line noise: cut it, so the call opens on the bot's hello.
const cut = Math.max(fromSec, Math.min(...words.filter((w) => w.speaker === "agent").map((w) => w.start)) - LEAD_IN);
for (const w of words) {
  w.start -= cut;
  w.end -= cut;
}
for (const b of beeps) {
  b.start -= cut;
  b.end -= cut;
}
const merged = mergeBeeps(beeps);

/**
 * The beep around a word Whisper put at [start, end]. Whisper is often a syllable late, so it
 * starts at the last pause 0.15–0.45 s before the word (0.3 s early if there's none) and ends at
 * the first pause after it. A pause: 22 dB under the speaker's usual level.
 */
function snapBeep(env: Float32Array, start: number, end: number): { start: number; end: number } {
  const voiced = [...env].filter((v) => v > 0.003).sort((x, y) => x - y);
  const quiet = (voiced[Math.floor(voiced.length * 0.75)] ?? 0.05) * 0.08;
  const f = (t: number) => Math.max(0, Math.min(env.length - 1, Math.round(t / SNAP_FRAME)));
  let a = start - 0.3;
  for (let i = f(start - 0.15); i >= f(start - 0.45); i--) {
    if (env[i]! < quiet) {
      a = i * SNAP_FRAME;
      break;
    }
  }
  let b = end + 0.3;
  for (let i = f(end + 0.05); i <= f(end + 0.45); i++) {
    if (env[i]! < quiet) {
      b = i * SNAP_FRAME;
      break;
    }
  }
  return { start: a - BEEP_PAD, end: b + BEEP_PAD };
}

function redactText(w: Word, r: Rule): string {
  const at = w.text.toLowerCase().indexOf(w.word.toLowerCase());
  const [pre, core, post] = at < 0 ? ["", w.text.trimEnd(), " "] : [w.text.slice(0, at), w.text.slice(at, at + w.word.length), w.text.slice(at + w.word.length)];
  const masked = r.show ?? (r.mask ? core.replace(/[A-Za-z0-9]/g, "*") : "*".repeat(core.length - (r.keepTail ?? 0)) + core.slice(core.length - (r.keepTail ?? 0)));
  return pre + masked + post;
}

function mergeBeeps(bs: DemoCall["beeps"]) {
  const out: DemoCall["beeps"] = [];
  for (const b of [...bs].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && last.speaker === b.speaker && b.start <= last.end + 0.15) last.end = Math.max(last.end, b.end);
    else out.push({ ...b, start: Math.max(0, b.start) });
  }
  return out.map((b) => ({ ...b, start: round(b.start), end: round(b.end) }));
}

// Lines: each speaker's words, split at pauses.
const lines: DemoLine[] = [];
for (const speaker of SPEAKERS) {
  let cur: Timed[] = [];
  const flush = () => {
    if (cur.length) lines.push({ speaker, start: round(cur[0]!.start), end: round(cur.at(-1)!.end), words: cur.map((w) => [round(w.start), w.text]) });
    cur = [];
  };
  for (const w of words.filter((w) => w.speaker === speaker)) {
    const prev = cur.at(-1);
    if (prev && (w.start - prev.end > LINE_GAP || (cur.length >= LINE_WORDS && /[.?!]\s*$/.test(prev.text)))) flush();
    cur.push(w);
  }
  flush();
}
lines.sort((a, b) => a.start - b.start);

if (values.preview) {
  const watchRe = watch ? new RegExp(watch, "i") : null;
  for (const l of lines) {
    const text = l.words.map((w) => w[1]).join("").trim();
    const raw = words.filter((w) => w.speaker === l.speaker && w.start >= l.start && w.start <= l.end).map((w) => w.word).join(" ");
    const flag = watchRe && (watchRe.test(raw) || watchRe.test(text)) ? "⚠" : " ";
    console.log(`${flag} ${fmt(l.start)}-${fmt(l.end)} ${l.speaker.padEnd(6)} ${text}`);
  }
  console.log("\nbeeps:", merged.map((b) => `${b.speaker[0]}${fmt(b.start)}-${fmt(b.end)}`).join(" "));
  process.exit(0);
}

// Audio: each channel to CHANNEL_LUFS, beeps in, a softened stereo mix, then the mix to FINAL_LUFS.
const ch: Record<Speaker, Float32Array> = {} as never;
for (const s of SPEAKERS) {
  const raw = await channelSamples(values.wav, s, RATE, endSec, fromSec);
  const from = Math.round((cut - fromSec) * RATE);
  const trimmed = raw.subarray(from);
  // a short fade in, so the cut doesn't click
  for (let i = 0; i < Math.min(trimmed.length, RATE * 0.05); i++) trimmed[i]! *= i / (RATE * 0.05);
  ch[s] = await loudnorm(trimmed.slice(), 1, CHANNEL_LUFS);
}
const n = Math.min(ch.caller.length, ch.agent.length);
const fade = Math.round(RATE * 0.01);
for (const b of merged) {
  const a = Math.round(b.start * RATE);
  const z = Math.min(n, Math.round(b.end * RATE));
  for (let i = a; i < z; i++) {
    const edge = Math.min(1, (i - a) / fade, (z - 1 - i) / fade);
    // Silence both sides (the other line can echo the word), then the beep on the speaker's.
    ch.caller[i] = 0;
    ch.agent[i] = 0;
    ch[b.speaker][i] = BEEP_GAIN * edge * Math.sin((2 * Math.PI * BEEP_HZ * (i - a)) / RATE);
  }
}
const mix = new Float32Array(n * 2);
for (let i = 0; i < n; i++) {
  mix[2 * i] = ch.caller[i]! + SPREAD * ch.agent[i]!;
  mix[2 * i + 1] = ch.agent[i]! + SPREAD * ch.caller[i]!;
}
const final = await loudnorm(mix, 2, FINAL_LUFS);

// The song (--song): SONG_GAP of silence after the call, then the song as it is. Over it the mouths
// follow the song, each while its singer's line plays.
let audio = final.subarray(0, n * 2);
const voice: Record<Speaker, Float32Array> = { caller: ch.caller.subarray(0, n), agent: ch.agent.subarray(0, n) };
let music: Float32Array | undefined;
let song: DemoCall["song"];
if (values.song && values.lyrics) {
  const { stdout } = await ffmpeg(["-i", values.song, "-ar", String(RATE), "-ac", "2", "-f", "f32le", "-"]);
  const tune = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
  const at = n + Math.round(SONG_GAP * RATE);
  const total = at + tune.length / 2;
  const withSong = new Float32Array(total * 2);
  withSong.set(audio);
  withSong.set(tune, at * 2);
  audio = withSong;
  music = new Float32Array(total);
  for (let i = 0; i < tune.length / 2; i++) music[at + i] = (tune[2 * i]! + tune[2 * i + 1]!) / 2;
  const lyrics = (await Bun.file(values.lyrics).json()) as { bpm: number; beat: number; lines: { speaker: SongLine["speaker"]; text: string }[] };
  const heard = ((await Bun.file(`${values.lyrics.replace(/[^/]*$/, "")}song.words.json`).json()) as { words: { word: string; start: number; end: number }[] }).words;
  const start = at / RATE;
  const lines = karaoke(lyrics.lines, heard).map((l) => ({ ...l, start: round(start + l.start), end: round(start + l.end), words: l.words.map(([t, w]): [number, string] => [round(start + t), w]) }));
  song = { start: round(start), end: round(total / RATE), bpm: lyrics.bpm, beat: round(start + lyrics.beat), lines };
  for (const s of SPEAKERS) {
    const v = new Float32Array(total);
    v.set(voice[s]);
    for (const l of lines.filter((l) => l.speaker === s || l.speaker === "both")) v.set(music.subarray(Math.round(l.start * RATE), Math.round(l.end * RATE)), Math.round(l.start * RATE));
    voice[s] = v;
  }
}
const duration = round(audio.length / 2 / RATE);
const frames = Math.ceil(duration * LEVEL_FPS);
const level = (x: Float32Array) => {
  const out = new Uint8Array(frames);
  out.set(levelBytes(envelope(x, RATE, 1 / LEVEL_FPS)).subarray(0, frames));
  return Buffer.from(out).toString("base64");
};
const levels: DemoCall["levels"] = { caller: level(voice.caller), agent: level(voice.agent), ...(music && { music: level(music) }) };

const outDir = "demos/calls";
const pcm = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
const raw = ["-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", "-"];
// The ID3 copyright tag (TCOP) carries demos/LICENSE with a downloaded file.
const tags = ["-metadata", `title=CallSitter: ${slug}`, "-metadata", "copyright=© 2026 szerintedmi. All rights reserved. https://callsitter.org"];
await ffmpeg([...raw, "-c:a", "libmp3lame", "-b:a", "128k", ...tags, `${outDir}/${slug}.mp3`], { stdin: pcm });
// Lossless, for the video (record.ts); it holds only the redacted audio, but is big: kept out of git.
await ffmpeg([...raw, "-c:a", "flac", `${values.words}/final.flac`], { stdin: pcm });

const call: DemoCall = { duration, lines, beeps: merged, levels, levelFps: LEVEL_FPS, ...callEvents(), ...(song && { song }) };
await Bun.write(`${outDir}/${slug}.json`, JSON.stringify(call));
console.log(`${outDir}/${slug}.{mp3,json}: ${fmt(call.duration)} (first ${cut.toFixed(2)} s cut), ${lines.length} lines, ${merged.length} beeps${song ? `, the song at ${fmt(song.start)} (${song.lines.length} lines)` : ""}`);

/**
 * The lyrics' words timed by Whisper's (song.words.json), seconds into the song: the two word lists
 * aligned by edit distance, so a word Whisper heard differently ("open a's" for "OpenAI's") still
 * takes its time; one it missed starts where the next heard one does.
 */
function karaoke(lyrics: { speaker: SongLine["speaker"]; text: string }[], heard: { word: string; start: number; end: number }[]): SongLine[] {
  const sung = lyrics.flatMap((l, line) => l.text.split(/(?<=\s)(?=\S)/).map((text) => ({ line, text: /\s$/.test(text) ? text : `${text} `, key: norm(text) })));
  const keys = heard.map((w) => norm(w.word));
  const cost = Array.from({ length: sung.length + 1 }, (_, i) => Float64Array.from({ length: keys.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= sung.length; i++)
    for (let j = 1; j <= keys.length; j++) cost[i]![j] = Math.min(cost[i - 1]![j - 1]! + (sung[i - 1]!.key === keys[j - 1] ? 0 : 1), cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1);
  const match: (number | undefined)[] = [];
  for (let i = sung.length, j = keys.length; i > 0; ) {
    if (j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + (sung[i - 1]!.key === keys[j - 1] ? 0 : 1)) match[--i] = --j;
    else if (j > 0 && cost[i]![j] === cost[i]![j - 1]! + 1) j--;
    else i--;
  }
  const timed = sung.map((w, i) => {
    const j = match[i] ?? match.slice(i).find((m) => m !== undefined);
    const h = j === undefined ? heard.at(-1)! : heard[j]!;
    return { ...w, start: match[i] === undefined && j === undefined ? h.end : h.start, end: match[i] === undefined ? undefined : h.end };
  });
  return lyrics.map((l, line) => {
    const ws = timed.filter((w) => w.line === line);
    return { speaker: l.speaker, start: ws[0]!.start, end: ws.at(-1)!.end ?? ws.at(-1)!.start + 0.3, words: ws.map((w): [number, string] => [w.start, w.text]) };
  });
}

function callEvents(): Pick<DemoCall, "verdicts" | "stages"> {
  if (!values.db || !values.call) return { verdicts: [], stages: [] };
  const db = new Database(values.db, { readonly: true });
  const rows = db.query("select type, data from events where call_id = ? and type in ('transcript', 'classification', 'stage') order by id").all(values.call) as { type: string; data: string }[];
  const evs = rows.map((r) => JSON.parse(r.data));
  // The database times events from the call's start, the recording from its own: line them up on the
  // agent's first words, or a clip's (--from) on its first agent line, found by how it starts.
  const agentLine = lines.find((l) => l.speaker === "agent");
  const head = (text: string) => text.split(/\s+/).map(norm).filter(Boolean).slice(0, 4).join(" ");
  const opening = head(agentLine?.words.map((w) => w[1]).join("") ?? "");
  const said = evs.find((e) => e.type === "transcript" && e.entry.speaker === "agent" && (!fromSec || head(e.entry.text) === opening));
  if (!said && fromSec) throw new Error(`no agent transcript in the database starts "${opening}"`);
  const shift = (said?.entry.at ?? 0) / 1000 - (agentLine?.start ?? 0);
  const t = (at: number) => round(at / 1000 - shift);
  // Before the clip: the last verdict holds at 0, a stage already entered starts at 0.
  const verdicts: DemoCall["verdicts"] = evs
    .filter((e) => e.type === "classification")
    .map((e) => {
      const p = e.classification.answers.verdict.probabilities;
      return [t(e.at), p.scam ?? 0, p.spam ?? 0, p.genuine ?? 0];
    });
  const before = verdicts.filter((v) => v[0] < 0).at(-1);
  return {
    verdicts: [...(before ? [[0, ...before.slice(1)] as DemoCall["verdicts"][number]] : []), ...verdicts.filter((v) => v[0] >= 0)],
    stages: evs.filter((e) => e.type === "stage").map((e) => [Math.max(0, t(e.at)), e.stage]),
  };
}

/** Two-pass EBU R128 normalization (linear gain) to `lufs`, true peak ≤ -1.5 dBTP. */
async function loudnorm(samples: Float32Array, channels: number, lufs: number): Promise<Float32Array> {
  const input = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const raw = ["-f", "f32le", "-ar", String(RATE), "-ac", String(channels), "-i", "-"];
  const target = `I=${lufs}:TP=-1.5:LRA=20`;
  const { stderr } = await ffmpeg(["-v", "info", ...raw, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { stdin: input });
  const json = stderr.slice(stderr.lastIndexOf("{"));
  const m = JSON.parse(json.slice(0, json.indexOf("}") + 1));
  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  const { stdout } = await ffmpeg([...raw, "-af", `loudnorm=${target}:${measured}:linear=true`, "-ar", String(RATE), "-f", "f32le", "-"], { stdin: input });
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

/** RMS to 0–255 on a log scale from -50 dBFS. */
function levelBytes(env: Float32Array): Uint8Array {
  return Uint8Array.from(env, (v) => Math.max(0, Math.min(255, Math.round(((20 * Math.log10(v + 1e-9) + 50) / 50) * 255))));
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}
function fmt(t: number) {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
}
