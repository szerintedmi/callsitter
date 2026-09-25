// Small, runtime-agnostic audio helpers (no Buffer/Node APIs).

/** pcmu/pcma: G.711 μ-law/A-law 8 kHz, passed through untouched. l16: 16 kHz linear. */
export const CODECS = ["pcmu", "pcma", "l16"] as const;
export type Codec = (typeof CODECS)[number];

export const isCodec = (s: string): s is Codec => (CODECS as readonly string[]).includes(s);

/**
 * Audio a voice session carries: a media codec, or pcm24 (24 kHz PCM16LE), which is what Live
 * reflects to a SIP sideband ("reflected sideband events use mono PCM16LE at 24 kHz").
 */
export type AudioFormat = Codec | "pcm24";

/** bytes per millisecond: G.711 8 kHz 8-bit, L16 16 kHz 16-bit, PCM 24 kHz 16-bit */
export const BYTES_PER_MS: Record<AudioFormat, number> = { pcmu: 8, pcma: 8, l16: 32, pcm24: 48 };
export const SAMPLE_RATE: Record<AudioFormat, number> = { pcmu: 8000, pcma: 8000, l16: 16000, pcm24: 24000 };
/** one byte/sample of silence */
export const SILENCE_BYTE: Record<AudioFormat, number> = { pcmu: 0xff, pcma: 0xd5, l16: 0x00, pcm24: 0x00 };

export function b64decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** G.711 byte → linear PCM16 sample (ITU-T G.711). */
function ulaw(b: number): number {
  b = ~b & 0xff;
  const t = (((b & 0x0f) << 3) + 0x84) << ((b & 0x70) >> 4);
  return b & 0x80 ? 0x84 - t : t - 0x84;
}
function alaw(b: number): number {
  b ^= 0x55;
  const seg = (b & 0x70) >> 4;
  let t = (b & 0x0f) << 4;
  t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1);
  return b & 0x80 ? t : -t;
}

/** Linear PCM16 samples of a chunk in the voice session's format (L16/PCM is little-endian). */
export function toPcm16(bytes: Uint8Array, codec: AudioFormat): Int16Array {
  if (codec === "l16" || codec === "pcm24") {
    const out = new Int16Array(bytes.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = (bytes[2 * i + 1]! << 8) | bytes[2 * i]!;
    return out;
  }
  const decode = codec === "pcmu" ? ulaw : alaw;
  return Int16Array.from(bytes, (b) => decode(b));
}

/** RMS level of a chunk in dBFS (0 = full scale, -Infinity = digital silence). */
export function levelDbfs(bytes: Uint8Array, codec: AudioFormat): number {
  const pcm = toPcm16(bytes, codec);
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return pcm.length ? 10 * Math.log10(sum / pcm.length / 32768 ** 2) : -Infinity;
}

/** Swaps byte order of 16-bit samples (big-endian ↔ little-endian). Returns a new array. */
export function swap16(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  return out;
}
