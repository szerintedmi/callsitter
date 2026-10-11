import { Hono } from "hono";
import type { ClientAssets } from "./admin";

// Real call recordings, the public site's home page: each recording with its transcript and an
// animation of the two sides (src/web/client/listen.ts). Names and personal details are already
// redacted in the files (demos/tools/build.ts). public.ts serves the page (realCallsPage) at its
// root and at /listen/<slug>, which opens it on that call, playing; the game moves to /play. Here:
//
//   GET listen/render/:slug  the stage alone, full window, for the video recorder (demos/tools/record.ts)
//   GET listen/media/:file   <slug>.mp3 and <slug>.json from demos/calls
//   GET assets/listen.js     the player

export type DemoScene = "police" | "cryptobot" | "electrician";

export interface Demo {
  slug: string;
  scene: DemoScene;
  /** its tab */
  title: string;
  /** the caller's name on the subtitles */
  caller: string;
  /** the end card's text, above its NEXT button ("" for none; \n breaks the line) */
  outcome: string;
}

export const DEMOS: Demo[] = [
  {
    slug: "police-scam",
    scene: "police",
    title: "The police",
    caller: "“DCI CLAUDE TAYLOR”",
    outcome: "13 minutes of a scammer's day, gone.\nNo real details given.",
  },
  {
    slug: "crypto-bot",
    scene: "cryptobot",
    title: "Bot vs bot",
    caller: "“SARAH”, SCAM BOT",
    outcome: "",
  },
  {
    slug: "electrician",
    scene: "electrician",
    title: "The electrician",
    caller: "THE ELECTRICIAN",
    outcome: "A real caller: message taken, passed on.",
  },
];

export const findDemo = (slug: string) => DEMOS.find((x) => x.slug === slug);

/** A demo's files by name, or undefined (src/runtime/demo-media.ts). Honours Range requests: audio seeks with them. */
export type DemoMedia = (name: string, req: Request) => Promise<Response | undefined>;

export function listenRoutes(d: { clientAssets: ClientAssets; media: DemoMedia }) {
  const app = new Hono();
  app.get("/listen/media/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[a-z0-9-]+\.(mp3|json)$/.test(file) || !DEMOS.some((x) => file.startsWith(`${x.slug}.`))) return c.notFound();
    return (await d.media(file, c.req.raw)) ?? c.notFound();
  });
  app.get("/listen/render/:slug", (c) => {
    const demo = findDemo(c.req.param("slug"));
    const base = c.req.path.slice(0, c.req.path.indexOf("listen/"));
    return demo ? c.html(renderPage(base, demo, c.req.query("poster") === "1")) : c.notFound();
  });
  app.get("/assets/listen.js", async (c) => {
    const body = await d.clientAssets("listen.js");
    return body === undefined
      ? c.notFound()
      : new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  });
  return app;
}

const BUILD = Date.now().toString(36);
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** What listen.ts reads from #rc-config. */
export interface PlayerConfig {
  demos: Demo[];
  selected: string;
  /** try to start playing at once (browsers often block sound until a tap: then the ▶ waits) */
  autoplay: boolean;
  /** frame-by-frame for the recorder: no audio, no controls */
  render: boolean;
  /** the recorder's still for the README: the ▶ shows */
  poster?: boolean;
  /** the mount point ("/" or "/public/") */
  base: string;
  /** the public site, on the video's end card */
  site?: string;
}

const stage = `<div class="rc-stage" id="rc-stage">
  <canvas id="rc-gl"></canvas>
  <div class="rc-mode" id="rc-mode"></div>
  <div class="rc-pop" id="rc-pop-caller"></div><div class="rc-pop" id="rc-pop-agent"></div>
  <div class="rc-beep" id="rc-beep-caller">BEEP</div><div class="rc-beep" id="rc-beep-agent">BEEP</div>
  <div class="rc-banner" id="rc-banner"></div>
  <div class="rc-subs" id="rc-subs"></div>
  <div class="rc-end" id="rc-end"><b id="rc-outcome"></b><button type="button" id="rc-next" hidden></button><span id="rc-site" hidden></span></div>
  <button class="rc-play" id="rc-play" type="button" aria-label="Play">▶</button>
  <div class="rc-seek" id="rc-seek"><i id="rc-progress"></i><i id="rc-mark"></i></div>
</div>`;

export const github = `<svg viewBox="0 0 16 16" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.06-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

/** "14:26:40": hours, minutes, seconds */
const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s) % 60].map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join(":");

/** The home page: the recordings, a call to play the game, and the bot's number. */
export function realCallsPage(base: string, o: { selected: string; autoplay: boolean; wastedSeconds: number; phone: string }): string {
  const config: PlayerConfig = { demos: DEMOS, selected: o.selected, autoplay: o.autoplay, render: false, base };
  const tabs = DEMOS.map(
    (x) => `<a class="rc-tab s-${x.scene}" href="${base}listen/${x.slug}" data-slug="${x.slug}">${esc(x.title)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Real calls to my phone, answered by ScamSitter, the bot that wastes scammers' time.">
<meta name="theme-color" content="#0e0d10">
<title>ScamSitter</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jersey+10&family=Pixelify+Sans:wght@500;600&display=swap">
<style>${rootCss}${homeCss}${realCallsCss}</style>
</head>
<body>
<header class="rc-top"><div><a class="rc-brand" href="${base}">SCAMSITTER</a><p class="rc-wasted">scammers' time wasted: <b>${hms(o.wastedSeconds)}</b></p></div><a class="rc-gh" href="https://github.com/szerintedmi/scamsitter" aria-label="ScamSitter on GitHub">${github}</a></header>
<main class="rc" id="rc">
  <h1 class="rc-h"><b>REAL CALL RECORDINGS</b><span>ScamSitter answering my phone</span></h1>
  <nav class="rc-tabs" aria-label="Recordings">${tabs}</nav>
  ${stage}
  <div class="rc-caption" id="rc-caption"></div>
  <a class="rc-cta" href="${base}play"><b>PLAY WITH THE BOT ▸</b><span>Call it from your browser</span></a>${
    o.phone ? `\n  <p class="rc-dial">OR FROM YOUR PHONE: <a href="tel:${o.phone.replaceAll(" ", "")}">${esc(o.phone)}</a></p>` : ""
  }
</main>
<audio id="rc-audio" preload="metadata" playsinline></audio>
<script type="application/json" id="rc-config">${json(config)}</script>
<script src="${base}assets/listen.js?v=${BUILD}"></script>
</body>
</html>`;
}

function renderPage(base: string, demo: Demo, poster: boolean) {
  const config: PlayerConfig = { demos: DEMOS, selected: demo.slug, autoplay: false, render: true, poster, base, site: "scamsitter.geekmango.com" };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(demo.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jersey+10&family=Pixelify+Sans:wght@500;600&display=swap">
<style>${rootCss}${realCallsCss}
html,body{overflow:hidden;background:#000}
.rc-stage{width:100vw;height:100vh;aspect-ratio:auto;box-shadow:none}</style>
</head>
<body class="rc-render">
${stage}
<script type="application/json" id="rc-config">${json(config)}</script>
<script src="${base}assets/listen.js?v=${BUILD}"></script>
</body>
</html>`;
}

// The game page's palette and fonts (public.ts).
const rootCss = `
:root{color-scheme:dark;--ink:#0e0d10;--ink2:#1b1a20;--line:#2c2a33;--paper:#fff6ec;--dim:#8d8994;--red:#d8281f;--red-hi:#ff5a4e;--grn:#35d07a;--grn-ink:#04230f;--amb:#ffb000;
--disp:"Jersey 10",ui-monospace,monospace;--text:"Pixelify Sans",ui-monospace,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ink);color:var(--paper);font-family:var(--text)}
a:focus-visible,button:focus-visible{outline:3px solid var(--amb);outline-offset:2px}
`;

const homeCss = `
.rc-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:4px 24px;max-width:1132px;margin:0 auto;padding:12px 16px 4px}
.rc-brand{font-family:var(--disp);font-size:clamp(28px,4vw,40px);line-height:1;letter-spacing:.03em;color:var(--paper);text-decoration:none}
.rc-gh{color:var(--dim);display:flex}
.rc-gh:hover{color:var(--paper)}
.rc{max-width:1132px;margin:0 auto;padding:8px 16px 32px}
.rc-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 14px;margin:8px 0 12px;font-weight:400}
.rc-h b{font-family:var(--disp);font-weight:400;font-size:clamp(34px,5.4vw,60px);line-height:.85;letter-spacing:.03em;color:var(--amb);text-shadow:3px 3px 0 #000}
.rc-h span{font-size:clamp(14px,1.6vw,18px);color:var(--dim)}
.rc-wasted{margin:4px 0 0;font-size:14px;color:var(--dim)}
.rc-wasted b{font-family:var(--disp);font-weight:400;font-size:20px;color:var(--amb);font-variant-numeric:tabular-nums}
.rc-tabs{display:grid;grid-template-columns:repeat(3,1fr);margin-bottom:10px;box-shadow:inset 0 0 0 3px var(--line)}
.rc-tab{display:flex;align-items:center;justify-content:center;min-height:48px;padding:6px 10px;text-align:center;font-family:var(--disp);font-size:clamp(17px,2.2vw,26px);line-height:1;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);text-decoration:none}
.rc-tab+.rc-tab{box-shadow:inset 3px 0 0 var(--line)}
.rc-tab:hover{color:var(--paper)}
.rc-tab[aria-current]{background:var(--amb);color:var(--ink);box-shadow:none}
.rc-cta{display:flex;flex-direction:column;align-items:center;gap:6px;margin:28px auto 0;max-width:560px;padding:14px 20px 16px;background:var(--red);color:var(--paper);text-decoration:none;box-shadow:6px 6px 0 #000}
.rc-cta b{font-family:var(--disp);font-weight:400;font-size:clamp(30px,4.4vw,44px);line-height:1;letter-spacing:.03em}
.rc-cta span{font-size:16px;opacity:.9}
.rc-cta:hover{transform:translate(-1px,-1px);box-shadow:7px 7px 0 #000}
.rc-cta:active{transform:translate(2px,2px);box-shadow:2px 2px 0 #000}
.rc-dial{margin:16px 0 0;text-align:center;font-family:var(--disp);font-size:18px;letter-spacing:.06em;color:var(--dim)}
.rc-dial a{color:var(--amb);text-decoration:none;white-space:nowrap}
@media (max-width:640px){
.rc-top{padding:10px 16px 2px}
.rc{padding:4px 0 24px}
.rc-h,.rc-tabs{margin-left:16px;margin-right:16px}
.rc-h{margin-top:6px;margin-bottom:8px}
.rc-tab{min-height:44px;font-size:15px;padding:4px 6px}
.rc-cta{margin:20px 16px 0}
.rc-dial{margin:12px 16px 0}
}
`;

// The stage is 16:9 and sizes its overlay in cqw, so the video frame (1920×1080) and a phone show
// the same picture; on a phone, floors keep the text readable and the subtitles move under it.
export const realCallsCss = `
.rc-stage{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;container-type:inline-size;background:#000;box-shadow:0 0 0 3px var(--line);font-family:var(--text);color:var(--paper);cursor:pointer;user-select:none}
#rc-gl{position:absolute;inset:0;width:100%;height:100%;display:block}
.rc-mode{position:absolute;right:2cqw;top:2cqw;font-family:var(--disp);font-size:max(2cqw,12px);letter-spacing:.05em;padding:.3cqw 1cqw;background:var(--red);color:var(--paper);border:.25cqw solid #000;box-shadow:.3cqw .3cqw 0 #000;transform:scale(var(--s,0));transform-origin:100% 0;white-space:nowrap;pointer-events:none}
.rc-mode.ok{background:var(--grn);color:var(--grn-ink)}
[data-scene="electrician"]{--rc-caller:var(--amb)}
[data-scene="cryptobot"]{--rc-caller:#c58bff}
.rc-pop{position:absolute;left:var(--x,0);top:var(--y,0);transform:translate(-50%,-100%) scale(var(--s,0));transform-origin:50% 100%;font-size:max(3.2cqw,16px);line-height:1;padding:.6cqw .9cqw;background:var(--paper);color:var(--ink);border:.25cqw solid #000;box-shadow:.3cqw .3cqw 0 #000;white-space:nowrap;pointer-events:none;font-family:var(--disp);text-align:center}
.rc-pop small{font-size:.55em;display:block;letter-spacing:.04em}
.rc-pop.dumb{background:var(--amb)}
.rc-beep{position:absolute;left:var(--x,0);top:var(--y,0);transform:translate(-50%,-50%) rotate(-8deg) scale(var(--s,0));font-family:var(--disp);font-size:max(3cqw,15px);color:#000;background:var(--amb);padding:.2cqw 1cqw;border:.3cqw solid #000;box-shadow:.4cqw .4cqw 0 #000;pointer-events:none;letter-spacing:.08em}
.rc-banner{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%) scale(var(--s,0));font-family:var(--disp);font-size:max(3cqw,15px);letter-spacing:.06em;padding:.4cqw 1.6cqw;background:var(--red);color:var(--paper);border:.3cqw solid #000;box-shadow:.5cqw .5cqw 0 #000;white-space:nowrap;pointer-events:none}
.rc-banner.ok{background:var(--grn);color:var(--grn-ink)}
.rc-subs{position:absolute;left:3cqw;right:3cqw;bottom:3cqw;display:flex;flex-direction:column;gap:.8cqw;pointer-events:none}
.rc-sub{max-width:64%;padding:.8cqw 1.2cqw;font-size:max(1.85cqw,11px);line-height:1.3;background:#0e0d10ee;border:.2cqw solid var(--line);box-shadow:.3cqw .3cqw 0 #000}
.rc-sub i{font-style:normal;color:#6f6a76}
.rc-sub i.on{color:var(--paper)}
.rc-sub i.red{background:var(--amb);color:#000;padding:0 .2em}
.rc-sub i.red:not(.on){background:#5a4a20;color:#0000}
.rc-sub .who{display:block;font-family:var(--disp);font-size:max(1.3cqw,10px);letter-spacing:.06em}
.rc-sub.caller{align-self:flex-start;border-left:.6cqw solid var(--rc-caller,var(--red-hi))}.rc-sub.caller .who{color:var(--rc-caller,var(--red-hi))}
.rc-sub.agent{align-self:flex-end;border-right:.6cqw solid var(--grn)}.rc-sub.agent .who{color:var(--grn);text-align:right}
.rc-sub.old{border-color:var(--line)}.rc-sub.old i.on{color:#a8a1b0}
.rc-end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2cqw;background:#0e0d10d8;opacity:var(--o,0);pointer-events:none;text-align:center;padding:0 8cqw}
.rc-end b{font-family:var(--disp);font-weight:400;font-size:max(4.4cqw,20px);line-height:1.05;text-shadow:.3cqw .3cqw 0 #000;white-space:pre-line}
.rc-end b:empty{display:none}
.rc-end span{font-family:var(--disp);font-size:max(2.4cqw,13px);color:var(--amb);letter-spacing:.08em}
.rc-end small{display:block;font-family:var(--text);font-size:.45em;color:var(--amb);margin-top:1.2cqw;letter-spacing:.02em}
#rc-next{pointer-events:auto;font-family:var(--disp);font-size:max(2.6cqw,15px);letter-spacing:.06em;padding:.6cqw 2cqw;background:var(--amb);color:var(--ink);border:.3cqw solid #000;box-shadow:.4cqw .4cqw 0 #000;cursor:pointer}
.rc-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:max(11cqw,56px);height:max(11cqw,56px);font-size:max(4.6cqw,24px);background:var(--red);border:.4cqw solid #000;box-shadow:.6cqw .6cqw 0 #000;color:var(--paper);cursor:pointer}
.rc.playing .rc-play,.rc.ended .rc-play,.rc-render:not(.poster) .rc-play{display:none}
.rc-seek{position:absolute;left:0;right:0;bottom:0;height:22px;display:flex;align-items:flex-end;cursor:pointer}
.rc-seek::before{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:#0e0d10b0}
#rc-progress{position:absolute;left:0;bottom:0;height:6px;width:0;background:var(--amb)}
#rc-mark{position:absolute;bottom:0;width:3px;height:10px;background:var(--red-hi);display:none}
.rc-render .rc-seek{display:none}
.rc-caption{display:none}
@media (max-width:640px){
.rc-stage{box-shadow:none}
.rc-subs{display:none}
.rc-caption{display:block;padding:10px 16px 0;font-size:16px;line-height:1.35}
.rc.playing .rc-caption{min-height:calc(3 * 1.35em + 28px)}
.rc-caption .rc-sub{max-width:none;font-size:16px;padding:8px 12px;border-width:2px}
.rc-caption .rc-sub .who{font-size:14px}
.rc-caption .rc-sub.caller{border-left-width:5px}.rc-caption .rc-sub.agent{border-right-width:5px}
}
`;
