// Transcribes a call recording per speaker, with word timings, for the demo builder (build.ts).
//
//   bun demos/tools/transcribe.ts <recording.wav> <out dir> [--end <sec>]
//
// Each channel is cut into utterances by its energy, and each utterance goes to Whisper on its
// own: a whole channel at once drops lines after long silences and smears word timings over
// them. Writes <out dir>/<speaker>.words.json. The output holds the unredacted transcript: keep it
// out of the repo (data/ is gitignored).
import OpenAI from "openai";
import { parseArgs } from "node:util";
import { SPEAKERS, VAD_FRAME, channelSamples, envelope, ffmpeg, utterances, type Speaker } from "./audio";

export interface Word {
  start: number;
  end: number;
  /** the word as Whisper split it, without punctuation */
  word: string;
  /** what the transcript shows for it: the word with its punctuation and the space after it */
  text: string;
}

const RATE = 16000;
const round = (x: number) => Math.round(x * 1000) / 1000;
const PAD = 0.25;
const PARALLEL = 6;
/** about -36 dBFS: quieter utterances are noise, not speech */
const MIN_PEAK = 0.015;
const peak = (env: Float32Array, a: number, b: number) => Math.max(...env.subarray(Math.floor(a / VAD_FRAME), Math.ceil(b / VAD_FRAME)));

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), options: { end: { type: "string" } }, allowPositionals: true });
const [wav, outDir] = positionals;
if (!wav || !outDir) throw new Error("usage: transcribe.ts <recording.wav> <out dir> [--end <sec>]");
const endSec = values.end ? Number(values.end) : undefined;
const client = new OpenAI();

async function transcribeChunk(samples: Float32Array, [a, b]: [number, number], speaker: Speaker): Promise<Word[]> {
  const from = Math.max(0, a - PAD);
  const slice = samples.subarray(Math.floor(from * RATE), Math.ceil((b + PAD) * RATE));
  const { stdout } = await ffmpeg(["-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", "-", "-c:a", "pcm_s16le", "-f", "wav", "-"], {
    stdin: new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength),
  });
  const r = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: new File([stdout], `${speaker}-${a.toFixed(2)}.wav`, { type: "audio/wav" }),
    language: "en",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });
  return withText(r.text, r.words ?? []).map((w) => ({ ...w, start: round(from + w.start), end: round(from + w.end) }));
}

/** Gives each word its stretch of `text`: the word, its punctuation, and the space after it. */
export function withText(text: string, words: { word: string; start: number; end: number }[]): Word[] {
  const lower = text.toLowerCase();
  const at: number[] = [];
  let cursor = 0;
  for (const w of words) {
    const i = lower.indexOf(w.word.toLowerCase(), cursor);
    at.push(i);
    if (i >= 0) cursor = i + w.word.length;
  }
  return words.map((w, k) => {
    const i = at[k]!;
    if (i < 0) return { ...w, text: `${w.word} ` };
    const nextAt = at.slice(k + 1).find((j) => j >= 0) ?? text.length;
    // The last word gets a space too: the next utterance's text follows it.
    const slice = text.slice(i, nextAt);
    return { ...w, text: nextAt === text.length ? `${slice.trimEnd()} ` : slice.replace(/\s+$/, " ") };
  });
}


for (const speaker of SPEAKERS) {
  const samples = await channelSamples(wav, speaker, RATE, endSec);
  const env = envelope(samples, RATE, VAD_FRAME);
  // Clicks and line noise (call setup, hang-up) make Whisper invent words ("Bye-bye.", "Peace.").
  const chunks = utterances(env, { mergeGap: 0.7, minLen: 0.15 }).filter(([a, b]) => peak(env, a, b) >= MIN_PEAK);
  const results: Word[][] = new Array(chunks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < chunks.length) {
        const i = next++;
        results[i] = await transcribeChunk(samples, chunks[i]!, speaker);
      }
    }),
  );
  const words = results.flat();
  await Bun.write(`${outDir}/${speaker}.words.json`, JSON.stringify(words, null, 1));
  console.log(`${speaker}: ${chunks.length} utterances, ${words.length} words`);
}
