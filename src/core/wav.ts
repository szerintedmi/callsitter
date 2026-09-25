import { toPcm16 } from "./audio";

// Two-track PCM16 recorder and WAV encoder (runtime-agnostic).
//
// Used for calls without a carrier recording: browser test calls and OpenAI SIP calls (from the
// sideband's reflected audio). The caller track starts at its first frame's arrival (browser) or
// with the recording (SIP) and is then written sequentially (the mic or SIP leg streams
// continuously, so it is the call's clock).
// Agent audio is placed at its arrival time (browser: as the page would start playing it) or at
// its session timestamp (SIP sideband). The agent track is therefore what Live actually sent: if
// a word is missing there, Live never produced it.

export class StereoRecorder {
  private caller: Int16Array[] = [];
  private callerSamples = 0;
  private agent: { at: number; pcm: Int16Array }[] = [];
  private agentEnd = 0;

  constructor(
    private rate: number,
    private startedAt: number,
    /** stop recording beyond this length (memory bound) */
    private maxSamples = rate * 60 * 20,
  ) {}

  /**
   * Little-endian PCM16 caller audio that arrived at `now` (wall clock). Without `now` the track
   * starts with the recording (SIP sideband: reflected audio covers the whole session).
   */
  addCaller(bytes: Uint8Array, now?: number) {
    if (this.callerSamples >= this.maxSamples) return;
    if (this.callerSamples === 0 && now !== undefined) {
      // Mic audio only flows once the voice session is up; leave the gap before it silent so
      // both tracks share one timeline.
      const lead = Math.min(this.maxSamples, Math.max(0, Math.round(((now - this.startedAt) / 1000) * this.rate)));
      this.caller.push(new Int16Array(lead));
      this.callerSamples = lead;
    }
    const pcm = toPcm16(bytes, "l16");
    this.caller.push(pcm);
    this.callerSamples += pcm.length;
  }

  /** Little-endian PCM16 agent audio that arrived at `now` (wall clock). */
  addAgent(bytes: Uint8Array, now: number) {
    this.addAgentAt(bytes, now - this.startedAt);
  }

  /** Little-endian PCM16 agent audio that starts `ms` into the recording. */
  addAgentAt(bytes: Uint8Array, ms: number) {
    const at = Math.max(Math.round((Math.max(0, ms) / 1000) * this.rate), this.agentEnd);
    if (at >= this.maxSamples) return;
    const pcm = toPcm16(bytes, "l16");
    this.agent.push({ at, pcm });
    this.agentEnd = at + pcm.length;
  }

  /** Stereo WAV: left = caller, right = agent. */
  toWav(): ArrayBuffer {
    const n = Math.min(this.maxSamples, Math.max(this.callerSamples, this.agentEnd));
    const left = new Int16Array(n);
    let pos = 0;
    for (const c of this.caller) {
      left.set(c.subarray(0, Math.max(0, n - pos)), pos);
      pos += c.length;
    }
    const right = new Int16Array(n);
    for (const a of this.agent) right.set(a.pcm.subarray(0, Math.max(0, n - a.at)), a.at);
    return encodeWav([left, right], this.rate);
  }
}


export function encodeWav(channels: Int16Array[], rate: number): ArrayBuffer {
  const ch = channels.length;
  const n = channels[0]?.length ?? 0;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * ch * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      v.setInt16(off, channels[c]![i]!, true);
      off += 2;
    }
  }
  return buf;
}
