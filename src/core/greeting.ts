import { b64decode, b64encode, BYTES_PER_MS, levelDbfs, SAMPLE_RATE, SILENCE_BYTE, toPcm16, type Codec } from "./audio";
import type { AppConfig, LiveConfig } from "./config";
import type { BlobStore, VoiceAgent } from "./ports";
import { encodeWav } from "./wav";

// The greeting, recorded from Live itself so it's the same voice. Live takes ~1.5 s to connect
// and ~2.7 s more to say "Hello?" when asked; a recording plays the moment the call connects
// while Live connects in parallel (started with the greeting as its first turn).
//
// Recorded per codec in the background at startup, and when the voice, greeting or model
// change. Files are named after those settings (greetings/<voice>-<codec>-<hash of model and
// greeting>.raw), so an existing recording is reused, e.g. after a restart or switching back.
// Each .raw (the codec's own bytes: L16 is PCM16LE 16 kHz, G.711 is 8 kHz) has a .wav next to
// it to listen to.

/** How long Live may take to connect and say the greeting. */
const RECORD_TIMEOUT_MS = 20_000;
/** Silence after the greeting's last speech that ends the recording. */
const END_SILENCE_MS = 700;
/** Audio kept before the first loud chunk (a soft onset like the "H" of "Hello") and after the last. */
const LEAD_MS = 100;
const TAIL_MS = 100;
/** bump when the recording method changes, so older files aren't reused (v1 kept faint noise, not speech) */
const FORMAT = 2;

/**
 * Has Live say the greeting in a throwaway session (fed silence) and returns its audio.
 * `speechDbfs`: chunks at least this loud are speech; Live also sends faint noise that isn't.
 */
export async function recordGreeting(
  voice: VoiceAgent,
  cfg: LiveConfig,
  codec: Codec,
  opts: { speechDbfs?: number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  const speechDbfs = opts.speechDbfs ?? -50;
  const chunks: Uint8Array[] = [];
  let firstSpeech = -1;
  let lastSpeech = -1;
  let lastSpeechAt = 0;
  let feed: ReturnType<typeof setInterval> | undefined;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  const session = await voice.connect(
    { config: cfg, codec },
    {
      onAudio: (b64) => {
        const bytes = b64decode(b64);
        chunks.push(bytes);
        if (levelDbfs(bytes, codec) < speechDbfs) return;
        if (firstSpeech < 0) firstSpeech = chunks.length - 1;
        lastSpeech = chunks.length - 1;
        lastSpeechAt = Date.now();
      },
      onTranscriptDelta() {},
      onTranscriptDone() {},
      onInterrupt() {},
      onDelegation() {},
      onError() {},
      onClose: () => finish(),
    },
  );
  try {
    // gpt-live-1 only advances while input audio arrives: feed it silence, like a quiet line.
    const silence = b64encode(new Uint8Array(100 * BYTES_PER_MS[codec]).fill(SILENCE_BYTE[codec]));
    feed = setInterval(() => {
      session.sendAudio(silence);
      if (lastSpeech >= 0 && Date.now() - lastSpeechAt >= END_SILENCE_MS) finish();
    }, 100);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done, new Promise<void>((r) => (timer = setTimeout(r, opts.timeoutMs ?? RECORD_TIMEOUT_MS)))]);
    clearTimeout(timer);
  } finally {
    clearInterval(feed);
    session.close();
  }
  if (firstSpeech < 0) throw new Error("Live didn't say the greeting");
  const before = concat(chunks.slice(0, firstSpeech));
  const lead = before.subarray(Math.max(0, before.length - LEAD_MS * BYTES_PER_MS[codec]));
  const speech = concat([lead, ...chunks.slice(firstSpeech, lastSpeech + 1)]);
  const out = new Uint8Array(speech.length + TAIL_MS * BYTES_PER_MS[codec]).fill(SILENCE_BYTE[codec]);
  out.set(speech);
  return out;
}

export interface GreetingCacheDeps {
  voice: VoiceAgent;
  blobs: BlobStore;
  config: () => AppConfig;
  /** codecs calls can use: the phone codec (connection.media_stream.codec) and l16 for browser test calls */
  codecs?: (cfg: AppConfig) => Codec[];
  /** injectable for tests */
  record?: typeof recordGreeting;
  log?: (msg: string) => void;
}

export class GreetingCache {
  /** recordings for the current config, by codec */
  private ready = new Map<Codec, { key: string; audio: Uint8Array }>();
  private running: Promise<void> = Promise.resolve();

  constructor(private d: GreetingCacheDeps) {}

  /** The recorded greeting for this codec, or null (not recorded yet, or the config changed since). */
  get(codec: Codec, cfg: AppConfig = this.d.config()): Uint8Array | null {
    const r = this.ready.get(codec);
    return r && r.key === greetingKey(cfg.live, codec) ? r.audio : null;
  }

  /** Makes sure every codec has a recording for the current config. Serialized; safe to call often. */
  refresh(): Promise<void> {
    this.running = this.running.then(() => this.refreshNow()).catch((err) => this.log(`refresh failed: ${errText(err)}`));
    return this.running;
  }

  private async refreshNow() {
    const cfg = this.d.config();
    if (!cfg.live.greeting) return;
    const codecs = this.d.codecs ? this.d.codecs(cfg) : [...new Set<Codec>([cfg.connection.media_stream.codec, "l16"])];
    for (const codec of codecs) {
      const key = greetingKey(cfg.live, codec);
      if (this.ready.get(codec)?.key === key) continue;
      const path = `greetings/${slug(voiceName(cfg.live))}-${codec}-${await hash(key)}.raw`;
      try {
        let audio = await this.load(path);
        if (audio && !hasSpeech(audio, codec, cfg.connection.speech_detection.agent_dbfs)) audio = null;
        if (audio) this.log(`${codec}: loaded (${cfg.live.voice}, ${ms(audio, codec)} ms)`);
        else {
          audio = await (this.d.record ?? recordGreeting)(this.d.voice, cfg.live, codec, {
            speechDbfs: cfg.connection.speech_detection.agent_dbfs,
          });
          await this.d.blobs.put(path, audio, "application/octet-stream");
          await this.d.blobs.put(path.replace(/\.raw$/, ".wav"), encodeWav([toPcm16(audio, codec)], SAMPLE_RATE[codec]), "audio/wav");
          this.log(`${codec}: recorded "${cfg.live.greeting}" (${cfg.live.voice}, ${ms(audio, codec)} ms)`);
        }
        this.ready.set(codec, { key, audio });
      } catch (err) {
        // Calls fall back to asking Live for the greeting.
        this.log(`${codec}: not recorded, calls will ask Live to greet: ${errText(err)}`);
      }
    }
  }

  private async load(path: string): Promise<Uint8Array | null> {
    const blob = await this.d.blobs.get(path);
    if (!blob) return null;
    const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
    return bytes.length ? bytes : null;
  }

  private log(msg: string) {
    (this.d.log ?? ((m: string) => console.log(m)))(`[greeting] ${msg}`);
  }
}

/** The voice settings that change how the greeting sounds (not the prompt: it barely does). */
function greetingKey(live: LiveConfig, codec: Codec): string {
  return JSON.stringify([FORMAT, live.model, live.voice, live.greeting, codec]);
}

/** Any 20 ms of the recording at least as loud as speech. */
function hasSpeech(audio: Uint8Array, codec: Codec, speechDbfs: number): boolean {
  const frame = 20 * BYTES_PER_MS[codec];
  for (let o = 0; o + frame <= audio.length; o += frame) {
    if (levelDbfs(audio.subarray(o, o + frame), codec) >= speechDbfs) return true;
  }
  return false;
}

/** Built-in voice name, or a custom voice's id. */
function voiceName(live: LiveConfig): string {
  return typeof live.voice === "string" ? live.voice : live.voice.id;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 40);

async function hash(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ms = (audio: Uint8Array, codec: Codec) => Math.round(audio.length / BYTES_PER_MS[codec]);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
