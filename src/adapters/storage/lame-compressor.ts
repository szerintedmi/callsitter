import { readdir, rename, rm } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { RecordingCompressor } from "../../core/ports";

// Compresses finished recordings with the `lame` CLI (installed in the Docker image): joint
// stereo at a constant bitrate, keeping the WAV's sample rate. It writes `<name>.mp3.encoding`,
// then renames it, so an MP3 under its real name is always complete. Not `.part`: that's
// FsRecordingStore's unfinished WAV, which recover() would turn into one. An encode a restart cut
// off is redone (and its file overwritten) by the startup sweep. Runs under `nice` where there is
// one, so encoding doesn't take CPU from live calls.

const ENCODING = ".encoding";

export class LameCompressor implements RecordingCompressor {
  private nice = Bun.which("nice");

  constructor(
    private root: string,
    /** where finished recordings are listed, under root */
    private dir = "recordings",
    private lame = "lame",
  ) {}

  private path(key: string) {
    const p = normalize(key);
    if (p.startsWith("..") || p.startsWith("/")) throw new Error(`invalid recording key: ${key}`);
    return join(this.root, p);
  }

  async compress(key: string, { kbps }: { kbps: number }) {
    if (!key.endsWith(".wav")) throw new Error(`not a WAV recording: ${key}`);
    const mp3 = key.slice(0, -".wav".length) + ".mp3";
    const out = this.path(mp3);
    const part = out + ENCODING;
    const cmd = [this.lame, "--quiet", "--nohist", "-m", "j", "-b", String(kbps), this.path(key), part];
    const proc = Bun.spawn(this.nice ? [this.nice, "-n", "19", ...cmd] : cmd, { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      await rm(part, { force: true });
      throw new Error(`lame exited with ${code}: ${stderr.trim().slice(-500)}`);
    }
    await rename(part, out);
    return mp3;
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }

  async listWav() {
    let names: string[];
    try {
      names = await readdir(this.path(this.dir));
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith(".wav")).map((n) => `${this.dir}/${n}`);
  }
}
