import { b64decode, b64encode, BYTES_PER_MS, SILENCE_BYTE, swap16, type Codec } from "../../core/audio";
import type { MediaChannel } from "../../core/ports";

// Telnyx bidirectional media stream (https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming).
// Outbound RTP chunks must be 20 ms to 30 s ("Provided chunks of audio can be in a size of
// 20 milliseconds to 30 seconds"), so Live's audio deltas are re-framed into ≥20 ms chunks.

const FRAME_MS = 20;
/** flush a partial frame (padded with silence) after this long without new audio */
const TAIL_FLUSH_MS = 60;

export type TelnyxInbound =
  | { event: "connected"; version?: string }
  | { event: "start"; stream_id: string; start: { call_control_id: string; media_format?: { encoding: string; sample_rate: number; channels: number } } }
  | { event: "media"; stream_id: string; media: { track: string; chunk?: string; timestamp?: string; payload: string } }
  | { event: "stop"; stream_id: string }
  | { event: "mark"; mark: { name: string } }
  | { event: "dtmf"; dtmf: { digit: string } }
  | { event: "error"; payload: { code: number; title: string; detail?: string } };

export function parseInbound(data: string | ArrayBuffer | Uint8Array): TelnyxInbound | null {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const msg = JSON.parse(text);
    return msg && typeof msg.event === "string" ? (msg as TelnyxInbound) : null;
  } catch {
    return null;
  }
}

/**
 * Converts inbound Telnyx audio to Live's format. PCMU/PCMA pass through; L16 is assumed to be
 * big-endian on the Telnyx side and little-endian on the Live side (verify in the spike).
 */
export function inboundToLive(payloadB64: string, codec: Codec): string {
  return codec === "l16" ? b64encode(swap16(b64decode(payloadB64))) : payloadB64;
}

export class TelnyxMediaChannel implements MediaChannel {
  private buf = new Uint8Array(0);
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private frameBytes: number;
  private closed = false;

  constructor(
    private sendRaw: (msg: string) => void,
    private closeRaw: () => void,
    private codec: Codec,
  ) {
    this.frameBytes = BYTES_PER_MS[codec] * FRAME_MS;
  }

  /** `payloadB64` is audio in Live's format. */
  sendAudio(payloadB64: string) {
    if (this.closed) return;
    let bytes: Uint8Array = b64decode(payloadB64);
    if (this.codec === "l16") bytes = swap16(bytes);
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);

    const whole = merged.length - (merged.length % this.frameBytes);
    if (whole > 0) this.emit(merged.subarray(0, whole));
    this.buf = merged.slice(whole);
    this.scheduleTailFlush();
  }

  clear() {
    this.buf = new Uint8Array(0);
    this.cancelTail();
    if (!this.closed) this.sendRaw(JSON.stringify({ event: "clear" }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelTail();
    this.closeRaw();
  }

  private emit(bytes: Uint8Array) {
    this.sendRaw(JSON.stringify({ event: "media", media: { payload: b64encode(bytes) } }));
  }

  private scheduleTailFlush() {
    this.cancelTail();
    if (this.buf.length === 0) return;
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      if (this.closed || this.buf.length === 0) return;
      const frame = new Uint8Array(this.frameBytes).fill(SILENCE_BYTE[this.codec]);
      frame.set(this.buf.subarray(0, this.frameBytes));
      this.buf = new Uint8Array(0);
      this.emit(frame);
    }, TAIL_FLUSH_MS);
  }

  private cancelTail() {
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
  }
}
