// Records a demo call's player (/listen/render/<slug>) to an MP4, frame by frame, with its audio:
// for YouTube, or to attach to the README.
//
//   bun demos/tools/record.ts <slug> [--out <file>] [--fps 30] [--size 1920x1080] [--from <s>] [--to <s>] [--workers 4]
//   bun demos/tools/record.ts <slug> --still <s>[,<s>…] [--poster]   PNG frames (--poster: with the ▶, for the README)
//
// Uses the installed Google Chrome (playwright-core doesn't download one). The page renders any time
// on request (window.demo.seek), so workers record their own stretch in parallel and the parts are
// joined without re-encoding. Audio: data/demos/<slug>/final.flac if it's there (build.ts), else
// the published MP3. The page's duration runs a few seconds past the audio, for the end card.
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { buildClient } from "../../src/runtime/client-assets";
import { demoMedia } from "../../src/runtime/demo-media";
import { listenRoutes } from "../../src/web/listen";
import { ffmpeg } from "./audio";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string" },
    fps: { type: "string", default: "30" },
    size: { type: "string", default: "1920x1080" },
    from: { type: "string" },
    to: { type: "string" },
    workers: { type: "string", default: "4" },
    still: { type: "string" },
    poster: { type: "boolean" },
  },
  allowPositionals: true,
});
const slug = positionals[0];
if (!slug) throw new Error("usage: record.ts <slug> [--out file] [--fps 30] [--size 1920x1080] [--from s] [--to s] [--workers 4] [--still s,…]");
const [width, height] = values.size!.split("x").map(Number) as [number, number];
const fps = Number(values.fps);

const built = await buildClient();
const app = new Hono().route("/", listenRoutes({ clientAssets: async (name) => built.get(name), media: demoMedia }));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const url = `http://127.0.0.1:${server.port}/listen/render/${slug}${values.poster ? "?poster=1" : ""}`;
/** the page's hook (src/web/client/listen.ts), seen from page.evaluate */
type PageGlobal = { demo: { duration: number; seek(t: number): void } };
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist"] });

async function openPage(): Promise<{ page: Page; duration: number }> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.error("page error:", err.message));
  await page.goto(url);
  await page.waitForSelector("body[data-ready]", { timeout: 30_000 });
  return { page, duration: await page.evaluate(() => (globalThis as unknown as PageGlobal).demo.duration) };
}

const seekShot = async (page: Page, t: number, type: "jpeg" | "png") => {
  await page.evaluate((t) => (globalThis as unknown as PageGlobal).demo.seek(t), t);
  return page.screenshot({ type, ...(type === "jpeg" ? { quality: 92 } : {}) });
};

try {
  if (values.still) {
    const { page } = await openPage();
    for (const t of values.still.split(",").map(Number)) {
      const out = `data/demos/stills/${slug}-${t}${values.poster ? "-poster" : ""}.png`;
      await Bun.write(out, await seekShot(page, t, "png"));
      console.log(out);
    }
  } else {
    const { page: first, duration } = await openPage();
    await first.close();
    const from = Number(values.from ?? 0);
    const to = Math.min(duration, Number(values.to ?? duration));
    const frames = Math.round((to - from) * fps);
    const workers = Math.max(1, Math.min(Number(values.workers), Math.ceil(frames / fps)));
    const out = values.out ?? `data/demos/video/${slug}${values.from || values.to ? `-${from}-${to}` : ""}.mp4`;
    mkdirSync(dirname(out), { recursive: true });
    const parts = Array.from({ length: workers }, (_, i) => `${out}.part${i}.mp4`);
    const started = Date.now();
    let done = 0;
    await Promise.all(
      parts.map(async (part, w) => {
        const a = Math.floor((frames * w) / workers);
        const b = Math.floor((frames * (w + 1)) / workers);
        const { page } = await openPage();
        const enc = Bun.spawn(
          ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), part],
          { stdin: "pipe", stderr: "inherit" },
        );
        for (let f = a; f < b; f++) {
          enc.stdin.write(await seekShot(page, from + f / fps, "jpeg"));
          if (++done % (fps * 10) === 0) {
            const rate = done / ((Date.now() - started) / 1000);
            console.log(`${slug}: ${Math.round((done / frames) * 100)}% (${rate.toFixed(1)} frames/s, ~${Math.round((frames - done) / rate / 60)} min left)`);
          }
        }
        await enc.stdin.end();
        if ((await enc.exited) !== 0) throw new Error(`encoding ${part} failed`);
        await page.close();
      }),
    );
    const list = `${out}.parts.txt`;
    await Bun.write(list, parts.map((p) => `file '${p.split("/").pop()}'`).join("\n"));
    const flac = Bun.file(`data/demos/${slug}/final.flac`);
    const audio = (await flac.exists()) ? flac.name! : `demos/calls/${slug}.mp3`;
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-ss", String(from), "-t", String(to - from), "-i", audio,
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "apad", "-c:a", "aac", "-b:a", "192k", "-t", String(frames / fps), "-movflags", "+faststart", out]);
    for (const p of [...parts, list]) await Bun.file(p).delete();
    console.log(`${out}: ${frames} frames in ${Math.round((Date.now() - started) / 1000)} s`);
  }
} finally {
  await browser.close();
  server.stop(true);
}
