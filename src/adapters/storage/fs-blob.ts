import { mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { BlobStore } from "../../core/ports";

/** Local-disk blob store (R2 later). Keys are relative paths under root. */
export class FsBlobStore implements BlobStore {
  constructor(private root: string) {}

  private path(key: string) {
    const p = normalize(key);
    if (p.startsWith("..") || p.startsWith("/")) throw new Error(`invalid blob key: ${key}`);
    return join(this.root, p);
  }

  async put(key: string, data: ArrayBuffer | Uint8Array, _contentType: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await Bun.write(p, data);
    return key;
  }

  async get(key: string) {
    const f = Bun.file(this.path(key));
    if (!(await f.exists())) return null;
    return { body: f, contentType: f.type };
  }
}
