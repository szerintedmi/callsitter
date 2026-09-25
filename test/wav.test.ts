import { describe, expect, test } from "bun:test";
import { encodeWav, StereoRecorder } from "../src/core/wav";

const le = (...samples: number[]) => {
  const b = new Uint8Array(samples.length * 2);
  samples.forEach((s, i) => new DataView(b.buffer).setInt16(i * 2, s, true));
  return b;
};
const samples = (wav: ArrayBuffer, channel: number, channels = 2) => {
  const v = new DataView(wav);
  const n = (wav.byteLength - 44) / 2 / channels;
  return Array.from({ length: n }, (_, i) => v.getInt16(44 + (i * channels + channel) * 2, true));
};

describe("wav", () => {
  test("encodes a valid stereo PCM16 header", () => {
    const wav = encodeWav([new Int16Array([1, 2]), new Int16Array([3, 4])], 16000);
    const v = new DataView(wav);
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(8);
    expect(samples(wav, 0)).toEqual([1, 2]);
    expect(samples(wav, 1)).toEqual([3, 4]);
  });

  test("recorder: caller sequential, agent placed at arrival and never overlapping itself", () => {
    // 1 kHz so 1 ms = 1 sample.
    const r = new StereoRecorder(1000, 0);
    r.addCaller(le(1, 1, 1, 1, 1, 1, 1, 1), 2); // mic starts 2 ms in (voice session connecting)
    r.addCaller(le(2), 50); // then sequential: a late frame doesn't open a gap
    r.addAgent(le(5, 5), 3); // arrives at 3 ms
    r.addAgent(le(6, 6), 3); // same burst: queued right after, not on top
    r.addAgent(le(7), 9);
    const wav = r.toWav();
    expect(samples(wav, 0)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(samples(wav, 1)).toEqual([0, 0, 0, 5, 5, 6, 6, 0, 0, 7, 0]);
  });
});
