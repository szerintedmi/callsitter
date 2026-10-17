// Records a demo call's player (/listen/render/<slug>) to an MP4, frame by frame, with its audio:
// for YouTube, Shorts and the like, or to attach to the README.
//
//   bun demos/tools/record.ts <slug> [--out <file>] [--fps 30] [--size 1920x1080] [--from <s>] [--to <s>] [--workers 4]
//   bun demos/tools/record.ts <slug> --still <s>[,<s>…] [--poster] [--out <dir>]   PNG frames (--poster: with the ▶, for the README)
//   bun demos/tools/record.ts <slug> --edit <cut.json> [--out <file>] [--size 1080x1920] [--still <s>,…]
//   any of them: [--layout wide|stack|follow] [--no-safe]
//
// Uses the installed Google Chrome (playwright-core doesn't download one). The page renders any time
// on request (window.demo.seek), so workers record their own stretch in parallel and the parts are
// joined without re-encoding. Audio: data/demos/<slug>/final.flac if it's there (build.ts), else
// the published MP3. The page's duration runs a few seconds past the audio, for the end card. The
// demos' files are found from the repo, so it runs from any directory; --out and --edit are paths
// from the working directory.
//
// Any frame size works. A tall one (1080x1920) stacks the rooms, the caller's over the bot's, and
// keeps the text off its bottom fifth and right edge, where Shorts, Reels and TikTok put the title
// and buttons (--no-safe lets it in). --layout fixes the layout: wide (side by side), stack, or
// follow (one camera on whoever spoke last).
//
// --edit renders an edit of the call instead: stretches of it in any order, stills, sped-up
// montages, and cards, the owner's messages to the bot, a call timer and an end card over them.
// --from/--to and --still are then on the edit's clock; the audio is cut from the same stretches,
// with short crossfades. The cut file (src/web/client/listen-cut.ts has its types):
//
// cut.json {"fade": 0.04,                                 the crossfade at every cut, s (default 0.04)
//           "segments": [                                 shown in order, end to end
//             {"from": 3.2, "to": 11.5},                  a stretch of the call (its own seconds)
//             {"from": 64.6, "to": 81, "snap": "bar"},    ends rounded to the song's bars ("beat": beats),
//                                                         from the call's song (bpm, first beat)
//             {"hold": 81, "for": 2.5},                   a still of one moment, silent: under a card
//             {"from": 90, "to": 150, "speed": 6,         sped up; its audio "mute" (the default
//              "audio": "fast"},                          faster than 1×) or "fast" (sped up too)
//             {"from": 160, "to": 170, "fade": 0.3}],     a longer crossfade into this one
//           "overlays": [                                 on the edit's clock: from "start" to "end"
//                                                         (left out: the end), "in": "pop" | "fade" |
//                                                         "none", "out": "fade" | "none"
//             {"type": "card", "start": 0, "end": 2.5, "text": "HE SAYS HE'S *NOT A BOT*",
//              "pos": "top", "size": 1.2, "dim": true},   *…* in amber, \n a new line; pos "top" |
//                                                         "center" | "bottom" or the middle's height 0–1
//             {"type": "message", "start": 4, "end": 9,  the phone's owner texting their bot, live: the
//              "chat": "MY BOT", "sender": "ME",          chat's and the sender's names, the bubbles one
//              "text": ["Ask him what model he is"],      after another ("every" s apart, default 1.6);
//              "side": "left", "pos": 0.4},               "left" | "right" | "center" (a tall frame: center)
//             {"type": "clock", "start": 0, "end": 20,   the call's time (it runs fast through a sped-up
//              "label": "into the call", "offset": 300,   stretch); "offset": the clip's start in the
//              "pos": "top-left"},                        whole call; "top-left" | "top" | "top-right"
//             {"type": "endcard", "start": 26, "title": "CALLSITTER", "subtitle": "…", "url": "callsitter.org"}]}
//
// Every segment lasts a whole number of frames (its end moves by under a frame), so the cuts land
// on frames and the sound, cut from the same pieces, stays in step with the picture.
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { buildClient } from "../../src/runtime/client-assets";
import { demoMedia } from "../../src/runtime/demo-media";
import { resolveCut, type Cut, type Piece } from "../../src/web/client/listen-cut";
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
    edit: { type: "string" },
    layout: { type: "string" },
    "no-safe": { type: "boolean" },
  },
  allowPositionals: true,
});
const slug = positionals[0];
if (!slug) {
  throw new Error(
    "usage: record.ts <slug> [--out file] [--fps 30] [--size 1920x1080] [--from s] [--to s] [--workers 4] [--still s,…] [--edit cut.json] [--layout wide|stack|follow] [--no-safe]",
  );
}
const [width, height] = values.size!.split("x").map(Number) as [number, number];
const fps = Number(values.fps);
const ROOT = join(import.meta.dir, "../..");
const cutFile = values.edit ? resolve(values.edit) : undefined;
const cut = cutFile ? ((await Bun.file(cutFile).json()) as Cut) : undefined;
const call = (await Bun.file(join(ROOT, `demos/calls/${slug}.json`)).json()) as { song?: { bpm: number; beat: number } };
/** the edit's pieces (the page cuts the picture by the same): for the sound */
const edited = cut ? resolveCut(cut, call.song, fps) : undefined;
if (cut && edited) {
  const span = (p: Piece) => (p.speed ? `${p.from.toFixed(2)}–${p.to.toFixed(2)}${p.speed !== 1 ? ` ×${p.speed}` : ""}` : `hold ${p.from}`);
  console.log(`${basename(cutFile!)}: ${edited.duration.toFixed(2)} s; at ${edited.pieces.map((p) => `${p.out.toFixed(2)} ${span(p)}`).join(", ")}`);
  for (const o of cut.overlays ?? []) if (o.start >= edited.duration) console.warn(`a ${o.type} at ${o.start} s starts after the edit's end`);
}

const built = await buildClient();
const app = new Hono().route("/", listenRoutes({ clientAssets: async (name) => built.get(name), media: demoMedia }));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
const query = new URLSearchParams();
if (values.poster) query.set("poster", "1");
if (values.layout) query.set("layout", values.layout);
if (values["no-safe"]) query.set("safe", "0");
const url = `http://127.0.0.1:${server.port}/listen/render/${slug}${query.size ? `?${query}` : ""}`;
/** the page's hook (src/web/client/listen.ts), seen from page.evaluate */
type PageGlobal = { demo: { duration: number; seek(t: number): void; edit(cut: Cut, fps: number): number; frame(t: number): void } };
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist"] });

/** A page ready to draw, with the edit loaded if there's one, and its length: the call's or the edit's. */
async function openPage(): Promise<{ page: Page; duration: number }> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.error("page error:", err.message));
  const res = await page.goto(url);
  if (!res?.ok()) throw new Error(`${url}: ${res?.status()} ${await res?.text()}`);
  await page.waitForSelector("body[data-ready]", { timeout: 30_000 });
  const duration: number = cut
    ? await page.evaluate(([cut, fps]) => (globalThis as unknown as PageGlobal).demo.edit(cut, fps), [cut, fps] as const)
    : await page.evaluate(() => (globalThis as unknown as PageGlobal).demo.duration);
  return { page, duration };
}

/** draws time t (the edit's with --edit, else the call's) and takes the frame */
const seekShot = async (page: Page, t: number, type: "jpeg" | "png") => {
  await page.evaluate(([t, edited]) => {
    const demo = (globalThis as unknown as PageGlobal).demo;
    if (edited) demo.frame(t);
    else demo.seek(t);
  }, [t, !!cut] as const);
  return page.screenshot({ type, ...(type === "jpeg" ? { quality: 92 } : {}) });
};

/** Frames at from + f/fps for f in [0, frames), by parallel workers, each encoding its stretch: the parts' concat list to mux. */
async function renderVideo(from: number, frames: number, out: string): Promise<{ list: string; parts: string[] }> {
  const workers = Math.max(1, Math.min(Number(values.workers), Math.ceil(frames / fps)));
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
  return { list, parts };
}

/**
 * The edit's sound into `wav`: `pieces` cut from `src` and laid end to end. Each stretch reaches
 * half a crossfade past its cuts, faded in and out (equal power), so the cuts overlap instead of
 * clicking and every stretch still starts on its frame. Holds and muted stretches are silent; a
 * sped-up one that isn't is sped up too (its pitch kept).
 */
async function cutAudio(pieces: Piece[], duration: number, src: string, wav: string) {
  const sounding = pieces.flatMap((p, i) => (p.audio !== "mute" && p.speed > 0 ? [{ p, next: pieces[i + 1] }] : []));
  if (!sounding.length) {
    await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(duration), "-c:a", "pcm_s16le", wav]);
    return;
  }
  const chains = sounding.map(({ p, next }, i) => {
    // half a crossfade either side, on the video's clock; not before the start of the video or of the recording
    const pre = Math.min(p.fade / 2, p.out, p.from / p.speed);
    const fadeOut = next?.fade ?? 0;
    const len = pre + p.len + fadeOut / 2;
    const filters = [`atrim=start=${p.from - pre * p.speed}:end=${p.to + (fadeOut / 2) * p.speed}`, "asetpts=PTS-STARTPTS"];
    // atempo goes up to 2× a pass in older ffmpegs
    for (let s = p.speed; s > 1.0001; s /= Math.min(2, s)) filters.push(`atempo=${Math.min(2, s)}`);
    if (p.fade > 0) filters.push(`afade=t=in:st=0:d=${Math.min(p.fade, len)}:curve=qsin`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, len - fadeOut)}:d=${Math.min(fadeOut, len)}:curve=qsin`);
    filters.push(`adelay=${Math.round((p.out - pre) * 1000)}:all=1`);
    return `[s${i}]${filters.join(",")}[p${i}]`;
  });
  const graph = [
    `[0:a]asplit=${sounding.length}${sounding.map((_, i) => `[s${i}]`).join("")}`,
    ...chains,
    `${sounding.map((_, i) => `[p${i}]`).join("")}amix=inputs=${sounding.length}:normalize=0:dropout_transition=0,apad,atrim=end=${duration}[out]`,
  ].join(";");
  await ffmpeg(["-i", src, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", wav]);
}

try {
  const name = cutFile ? basename(cutFile, ".json") : slug;
  if (values.still) {
    const { page } = await openPage();
    const dir = values.out ?? join(ROOT, "data/demos/stills");
    for (const t of values.still.split(",").map(Number)) {
      const out = `${dir}/${name}-${t}${values.poster ? "-poster" : ""}.png`;
      await Bun.write(out, await seekShot(page, t, "png"));
      console.log(out);
    }
  } else {
    const started = Date.now();
    const { page: first, duration } = await openPage();
    await first.close();
    const from = Number(values.from ?? 0);
    const to = Math.min(duration, Number(values.to ?? duration));
    const frames = Math.round((to - from) * fps);
    const out = values.out ?? join(ROOT, `data/demos/video/${name}${values.from || values.to ? `-${from}-${to}` : ""}.mp4`);
    mkdirSync(dirname(out), { recursive: true });
    const { list, parts } = await renderVideo(from, frames, out);
    const flac = Bun.file(join(ROOT, `data/demos/${slug}/final.flac`));
    let sound = (await flac.exists()) ? flac.name! : join(ROOT, `demos/calls/${slug}.mp3`);
    if (edited) {
      // the edit's own, on its clock
      await cutAudio(edited.pieces, edited.duration, sound, `${out}.audio.wav`);
      sound = `${out}.audio.wav`;
    }
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-ss", String(from), "-t", String(to - from), "-i", sound,
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "apad", "-c:a", "aac", "-b:a", "192k", "-t", String(frames / fps), "-movflags", "+faststart", out]);
    for (const p of [...parts, list, ...(cut ? [sound] : [])]) await Bun.file(p).delete();
    console.log(`${out}: ${frames} frames in ${Math.round((Date.now() - started) / 1000)} s`);
  }
} finally {
  await browser.close();
  server.stop(true);
}
