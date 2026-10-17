import { toPcm16 } from "./audio";
import type { RecordingWriter } from "./ports";

// Two-track PCM16 recorder and WAV encoder (runtime-agnostic).
//
// Used for calls without a carrier recording: browser test calls and OpenAI SIP calls (from the
// sideband's reflected audio). The caller track starts at its first frame's arrival (browser) or
// with the recording (SIP) and is then written sequentially (the mic or SIP leg streams
// continuously, so it is the call's clock).
// Agent audio is placed at its arrival time (browser: as the page would start playing it) or at
// its session timestamp (SIP sideband). The agent track is therefore what Live actually sent: if
// a word is missing there, Live never produced it.
//
// The recording streams out while the call runs: audio that no later write can change is
// interleaved into stereo PCM16 frames and handed to a RecordingWriter in blocks, so only the
// unsettled tail stays in memory. Caller audio is only ever appended, and agent audio only ever
// placed at or after the agent track's end, so a sample is final once it is behind the caller
// track's end and either behind the agent track's end or more than `settle` behind the caller
// track (agent audio is generated at or ahead of the call's clock, never seconds behind it).

/** a track's audio, `at` samples into the recording; chunks are in order and don't overlap */
interface Chunk {
  at: number;
  pcm: Int16Array;
}

export interface StereoRecorderOptions {
  /** stop recording beyond this length (samples); extend() raises it */
  maxSamples?: number;
  /** how far (seconds) agent audio may land behind the caller track's end (see above) */
  settleSeconds?: number;
  /** hand settled audio over once at least this much (seconds) has settled */
  blockSeconds?: number;
}

export class StereoRecorder {
  private caller: Chunk[] = [];
  private callerSamples = 0;
  private agent: Chunk[] = [];
  private agentEnd = 0;
  /** samples already handed to the writer */
  private flushed = 0;
  private maxSamples: number;
  private settle: number;
  private block: number;
  private finished?: Promise<string | null>;

  constructor(
    private rate: number,
    private startedAt: number,
    private out: RecordingWriter,
    o: StereoRecorderOptions = {},
  ) {
    this.maxSamples = o.maxSamples ?? rate * 60 * 20;
    this.settle = Math.round((o.settleSeconds ?? 3) * rate);
    this.block = Math.max(1, Math.round((o.blockSeconds ?? 5) * rate));
  }

  /** Records up to `seconds` from the start, if that's longer than it would have (never shorter). */
  extend(seconds: number) {
    this.maxSamples = Math.max(this.maxSamples, Math.round(seconds * this.rate));
    this.maybeFlush();
  }

  /** samples held in memory, not yet handed to the writer */
  get pendingSamples(): number {
    let n = 0;
    for (const c of this.caller) n += c.pcm.length;
    for (const a of this.agent) n += a.pcm.length;
    return n;
  }

  /**
   * Little-endian PCM16 caller audio that arrived at `now` (wall clock). Without `now` the track
   * starts with the recording (SIP sideband: reflected audio covers the whole session).
   */
  addCaller(bytes: Uint8Array, now?: number) {
    if (this.finished || this.callerSamples >= this.maxSamples) return;
    if (this.callerSamples === 0 && now !== undefined) {
      // Mic audio only flows once the voice session is up; leave the gap before it silent so
      // both tracks share one timeline.
      this.callerSamples = Math.min(this.maxSamples, Math.max(0, Math.round(((now - this.startedAt) / 1000) * this.rate)));
    }
    const pcm = toPcm16(bytes, "l16");
    if (pcm.length) this.caller.push({ at: this.callerSamples, pcm });
    this.callerSamples += pcm.length;
    this.maybeFlush();
  }

  /**
   * Silence on the caller track up to `now` (wall clock), if it's behind: e.g. the gap between a
   * SIP sideband's end and a takeover's caller audio, so what follows lines up with the agent track.
   */
  padCaller(now: number) {
    if (this.finished) return;
    const at = Math.min(this.maxSamples, Math.round(((now - this.startedAt) / 1000) * this.rate));
    if (at <= this.callerSamples) return;
    this.callerSamples = at;
    this.maybeFlush();
  }

  /** Little-endian PCM16 agent audio that arrived at `now` (wall clock). */
  addAgent(bytes: Uint8Array, now: number) {
    this.addAgentAt(bytes, now - this.startedAt);
  }

  /** Little-endian PCM16 agent audio that starts `ms` into the recording. */
  addAgentAt(bytes: Uint8Array, ms: number) {
    if (this.finished) return;
    // Never on top of earlier agent audio; and never into audio already handed over (only when it
    // lands more than `settle` behind the caller track: then it's placed late rather than lost).
    const at = Math.max(Math.round((Math.max(0, ms) / 1000) * this.rate), this.agentEnd, this.flushed);
    if (at >= this.maxSamples) return;
    const pcm = toPcm16(bytes, "l16");
    if (pcm.length) this.agent.push({ at, pcm });
    this.agentEnd = at + pcm.length;
    this.maybeFlush();
  }

  /**
   * Hands the rest over and finishes the writer (once): left = caller, right = agent. Resolves to
   * what the writer resolves to (the stored path, or null if nothing was stored).
   */
  finish(): Promise<string | null> {
    if (!this.finished) {
      const n = Math.min(this.maxSamples, Math.max(this.callerSamples, this.agentEnd));
      if (n > this.flushed) this.flushTo(n);
      this.caller = [];
      this.agent = [];
      this.finished = this.out.finish();
    }
    return this.finished;
  }

  /** the end of the audio no later write can change */
  private settled(): number {
    return Math.min(this.maxSamples, this.callerSamples, Math.max(this.agentEnd, this.callerSamples - this.settle));
  }

  private maybeFlush() {
    const to = this.settled();
    if (to - this.flushed >= this.block) this.flushTo(to);
  }

  /** Interleaves [flushed, to) into stereo frames for the writer and drops what it used. */
  private flushTo(to: number) {
    const from = this.flushed;
    const len = to - from;
    const left = new Int16Array(len);
    const right = new Int16Array(len);
    take(this.caller, left, from, to);
    take(this.agent, right, from, to);
    const bytes = new Uint8Array(len * 4);
    const v = new DataView(bytes.buffer);
    for (let i = 0; i < len; i++) {
      v.setInt16(i * 4, left[i]!, true);
      v.setInt16(i * 4 + 2, right[i]!, true);
    }
    this.flushed = to;
    this.out.append(bytes);
  }
}

/** Copies the chunks' audio in [from, to) into `dst` (which starts at `from`), dropping chunks that end by `to`. */
function take(chunks: Chunk[], dst: Int16Array, from: number, to: number) {
  let used = 0;
  for (const c of chunks) {
    if (c.at >= to) break;
    const start = Math.max(c.at, from);
    const end = Math.min(c.at + c.pcm.length, to);
    if (end > start) dst.set(c.pcm.subarray(start - c.at, end - c.at), start - from);
    if (c.at + c.pcm.length > to) break;
    used++;
  }
  chunks.splice(0, used);
}

/** A RecordingWriter that keeps the WAV in memory (evals, tests); wav() once finished. */
export class WavBuffer implements RecordingWriter {
  private parts: Uint8Array[] = [];
  private bytes = 0;

  constructor(
    private rate: number,
    private channels: number,
  ) {}

  append(pcm: Uint8Array) {
    this.parts.push(pcm);
    this.bytes += pcm.length;
  }

  finish(): Promise<string | null> {
    return Promise.resolve(null);
  }

  wav(): ArrayBuffer {
    const out = new Uint8Array(WAV_HEADER_BYTES + this.bytes);
    out.set(wavHeader(this.rate, this.channels, this.bytes));
    let off = WAV_HEADER_BYTES;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out.buffer;
  }
}

export const WAV_HEADER_BYTES = 44;

/** The 44-byte header of a PCM16 WAV with `dataBytes` of audio. */
export function wavHeader(rate: number, channels: number, dataBytes: number): Uint8Array {
  const h = new Uint8Array(WAV_HEADER_BYTES);
  const v = new DataView(h.buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  return h;
}

export function encodeWav(channels: Int16Array[], rate: number): ArrayBuffer {
  const ch = channels.length;
  const n = channels[0]?.length ?? 0;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + n * ch * 2);
  new Uint8Array(buf).set(wavHeader(rate, ch, n * ch * 2));
  const v = new DataView(buf);
  let off = WAV_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      v.setInt16(off, channels[c]![i]!, true);
      off += 2;
    }
  }
  return buf;
}
