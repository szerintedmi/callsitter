import type { BlobStore, RecordingStore } from "./ports";
import { WavBuffer } from "./wav";

/**
 * A RecordingStore without streaming: the WAV is kept in memory and put to the blob store when it
 * finishes. For setups without a writable disk (and tests); nothing survives a crash.
 */
export function bufferedRecordings(blobs: BlobStore): RecordingStore {
  return {
    open(key, { rate, channels }) {
      const buf = new WavBuffer(rate, channels);
      return {
        append: async (pcm) => buf.append(pcm),
        finish: () => blobs.put(key, buf.wav(), "audio/wav"),
      };
    },
  };
}
