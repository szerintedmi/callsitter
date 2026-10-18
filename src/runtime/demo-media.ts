import { statSync } from "node:fs";
import { join } from "node:path";
import { DEMOS, type DemoMedia } from "../web/listen";

const DIR = join(import.meta.dir, "../../demos/calls");
const TYPES: Record<string, string> = { mp3: "audio/mpeg", json: "application/json" };

/** per slug: its files' size and mtime, and the hash of their contents */
const hashes = new Map<string, { stamp: string; v: string }>();

/**
 * A recording's version for its media URLs (?v=): a hash of its .mp3 and .json, so a deploy keeps the
 * unchanged recordings cached. Hashed again only when a file's size or mtime changes.
 */
async function version(slug: string): Promise<string> {
  const files = [`${slug}.mp3`, `${slug}.json`].map((n) => join(DIR, n));
  const stamp = files.map((f) => statSync(f, { throwIfNoEntry: false })).map((s) => `${s?.size}:${s?.mtimeMs}`).join("/");
  const known = hashes.get(slug);
  if (known?.stamp === stamp) return known.v;
  const hasher = new Bun.CryptoHasher("sha256");
  for (const f of files) {
    const file = Bun.file(f);
    if (await file.exists()) hasher.update(await file.arrayBuffer());
  }
  const v = hasher.digest("hex").slice(0, 12);
  hashes.set(slug, { stamp, v });
  return v;
}

/**
 * The demo calls' files (src/web/listen.ts), with Range support: browsers seek audio with them. Kept
 * for a year under the recording's current ?v=, for an hour under any other.
 */
export const demoMedia: DemoMedia = {
  async file(name, req) {
    const file = Bun.file(join(DIR, name));
    if (!(await file.exists())) return undefined;
    const slug = name.slice(0, name.lastIndexOf("."));
    const fixed = new URL(req.url).searchParams.get("v") === (await version(slug));
    const headers: Record<string, string> = {
      "Content-Type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": fixed ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (!m || (!m[1] && !m[2])) return new Response(file, { headers });
    const size = file.size;
    // "bytes=a-b", "bytes=a-" or the last n bytes ("bytes=-n")
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` } });
  },
  async versions() {
    return Object.fromEntries(await Promise.all(DEMOS.map(async (x) => [x.slug, await version(x.slug)] as const)));
  },
};
