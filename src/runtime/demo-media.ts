import { join } from "node:path";
import type { DemoMedia } from "../web/listen";

const DIR = join(import.meta.dir, "../../demos/calls");
const TYPES: Record<string, string> = { mp3: "audio/mpeg", json: "application/json" };

/** The demo calls' files (src/web/listen.ts), with Range support: browsers seek audio with it. */
export const demoMedia: DemoMedia = async (name, req) => {
  const file = Bun.file(join(DIR, name));
  if (!(await file.exists())) return undefined;
  const headers: Record<string, string> = {
    "Content-Type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (!m || (!m[1] && !m[2])) return new Response(file, { headers });
  const size = file.size;
  // "bytes=a-b", "bytes=a-" or the last n bytes ("bytes=-n")
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` } });
};
