import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { RecordingSink, RecordingStore } from "../../core/ports";
import { WAV_HEADER_BYTES, wavHeader } from "../../core/wav";

// Recordings on local disk, written while the call runs: `<key>.part` gets a WAV header with
// placeholder sizes, then the PCM as it comes (synced to disk on each append, every few seconds
// of audio); finish() writes the real sizes and renames it to `<key>`, where FsBlobStore (same
// root) serves it. After a crash, recover() finishes each `.part` from its length.

const PART = ".part";

export class FsRecordingStore implements RecordingStore {
  constructor(
    private root: string,
    /** where unfinished recordings are looked for, under root */
    private dir = "recordings",
  ) {}

  private path(key: string) {
    const p = normalize(key);
    if (p.startsWith("..") || p.startsWith("/")) throw new Error(`invalid recording key: ${key}`);
    return join(this.root, p);
  }

  open(key: string, { rate, channels }: { rate: number; channels: number }): RecordingSink {
    const path = this.path(key);
    const part = path + PART;
    let fh: FileHandle | undefined;
    let bytes = 0;
    // The file is only created by the first write, so a recording that never starts leaves nothing.
    const file = async () => {
      if (fh) return fh;
      await mkdir(dirname(part), { recursive: true });
      fh = await open(part, "w");
      await fh.write(wavHeader(rate, channels, 0), 0, WAV_HEADER_BYTES, 0);
      return fh;
    };
    return {
      async append(pcm) {
        const f = await file();
        // A short write (a nearly full disk) mustn't leave a hole: go on from where it stopped.
        for (let done = 0; done < pcm.length; ) {
          const { bytesWritten } = await f.write(pcm, done, pcm.length - done, WAV_HEADER_BYTES + bytes + done);
          if (bytesWritten === 0) throw new Error(`recording ${key}: nothing written (disk full?)`);
          done += bytesWritten;
        }
        bytes += pcm.length;
        await f.datasync();
      },
      async finish() {
        const f = await file();
        try {
          await f.write(wavHeader(rate, channels, bytes), 0, WAV_HEADER_BYTES, 0);
          await f.datasync();
        } finally {
          await f.close();
        }
        await rename(part, path);
        return key;
      },
    };
  }

  /** Finishes every `.part` under the recordings dir; resolves to their keys. Run before any call starts. */
  async recover(): Promise<string[]> {
    const dir = this.path(this.dir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const name of names.filter((n) => n.endsWith(PART))) {
      const part = join(dir, name);
      if (!(await finishPart(part))) continue;
      // Never over a finished recording of the same name: that one stays the call's.
      let base = name.slice(0, -PART.length);
      if (await exists(join(dir, base))) base = base.replace(/(\.[^.]+)?$/, ".recovered$1");
      await rename(part, join(dir, base));
      keys.push(`${this.dir}/${base}`);
    }
    return keys;
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * Makes a crashed recording's `.part` a valid WAV: sizes from its length, less a trailing partial
 * frame. False (and the file deleted) if it doesn't even have its header.
 */
async function finishPart(part: string): Promise<boolean> {
  const size = (await stat(part)).size;
  if (size < WAV_HEADER_BYTES) {
    await rm(part, { force: true });
    return false;
  }
  const fh = await open(part, "r+");
  try {
    const head = new Uint8Array(WAV_HEADER_BYTES);
    await fh.read(head, 0, WAV_HEADER_BYTES, 0);
    const v = new DataView(head.buffer);
    const channels = v.getUint16(22, true);
    const rate = v.getUint32(24, true);
    const frame = Math.max(1, channels) * 2;
    const bytes = size - WAV_HEADER_BYTES - ((size - WAV_HEADER_BYTES) % frame);
    await fh.truncate(WAV_HEADER_BYTES + bytes);
    await fh.write(wavHeader(rate, channels, bytes), 0, WAV_HEADER_BYTES, 0);
    await fh.datasync();
  } finally {
    await fh.close();
  }
  return true;
}
