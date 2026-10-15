// Shared helpers for the demo tools: ffmpeg wrappers and an energy-based voice detector.
// Recordings are stereo 24 kHz PCM16 WAVs: left the caller, right the agent.

export type Speaker = "caller" | "agent";
export const CHANNEL: Record<Speaker, number> = { caller: 0, agent: 1 };
export const SPEAKERS: Speaker[] = ["caller", "agent"];

export async function run(cmd: string[], opts: { stdin?: Uint8Array } = {}): Promise<{ stdout: Uint8Array; stderr: string }> {
  const p = Bun.spawn(cmd, { stdin: opts.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (opts.stdin) {
    p.stdin!.write(opts.stdin);
    await p.stdin!.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} … exited ${code}\n${stderr.slice(-2000)}`);
  return { stdout, stderr };
}

export const ffmpeg = (args: string[], opts?: { stdin?: Uint8Array }) => run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", ...args], opts);

/** One channel of `wav` as mono float samples at `rate`, from `fromSec` (sample 0) to `endSec` if given. */
export async function channelSamples(wav: string, speaker: Speaker, rate: number, endSec?: number, fromSec = 0): Promise<Float32Array> {
  const cut = endSec ? ["-t", String(endSec - fromSec)] : [];
  const { stdout } = await ffmpeg([...(fromSec ? ["-ss", String(fromSec)] : []), "-i", wav, ...cut, "-af", `pan=mono|c0=c${CHANNEL[speaker]}`, "-ar", String(rate), "-f", "f32le", "-"]);
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

/** RMS per frame of `frameSec`. */
export function envelope(samples: Float32Array, rate: number, frameSec: number): Float32Array {
  const n = Math.round(rate * frameSec);
  const out = new Float32Array(Math.ceil(samples.length / n));
  for (let f = 0; f < out.length; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * n);
    for (let i = f * n; i < end; i++) sum += samples[i]! * samples[i]!;
    out[f] = Math.sqrt(sum / Math.max(1, end - f * n));
  }
  return out;
}

export const VAD_FRAME = 0.02;
/** about -50 dBFS: the recordings' noise floor is far below (telephony ~-72, TTS digital silence) */
const VAD_THRESHOLD = 0.003;

/** Speech stretches [start, end] in seconds: voiced frames, gaps under `mergeGap` joined, blips dropped. */
export function utterances(env: Float32Array, opts: { mergeGap?: number; minLen?: number } = {}): [number, number][] {
  const mergeGap = opts.mergeGap ?? 0.5;
  const minLen = opts.minLen ?? 0.12;
  const out: [number, number][] = [];
  for (let f = 0; f < env.length; f++) {
    if (env[f]! < VAD_THRESHOLD) continue;
    const t = f * VAD_FRAME;
    const last = out.at(-1);
    if (last && t - last[1] <= mergeGap) last[1] = t + VAD_FRAME;
    else out.push([t, t + VAD_FRAME]);
  }
  return out.filter(([a, b]) => b - a >= minLen);
}

/** Whether any frame of `env` in [a, b] is voiced. */
export const voicedIn = (env: Float32Array, a: number, b: number) => {
  for (let f = Math.max(0, Math.floor(a / VAD_FRAME)); f < Math.min(env.length, Math.ceil(b / VAD_FRAME)); f++) if (env[f]! >= VAD_THRESHOLD) return true;
  return false;
};
