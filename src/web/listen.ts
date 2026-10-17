import { Hono } from "hono";
import type { ClientAssets } from "./admin";
import { favicon, logo } from "./favicon";

// Real call recordings, the public site's home page: each recording with its transcript and an
// animation of the two sides (src/web/client/listen.ts). Names and personal details are already
// redacted in the files (demos/tools/build.ts). public.ts serves the page (realCallsPage) at its
// root and at /listen/<slug>, which opens it on that call, playing; the game moves to /play. Here:
//
//   GET listen/render/:slug  the stage alone, full window, for the video recorder (demos/tools/record.ts);
//                            ?layout=wide|stack|follow fixes the rooms' layout (else from the window's
//                            shape), ?safe=0 lets text into a tall frame's bottom fifth and right edge
//   GET listen/media/:file   <slug>.mp3 and <slug>.json from demos/calls
//   GET assets/listen.js     the player

export type DemoScene = "areyouai" | "police" | "cryptobot" | "electrician" | "coldcall";

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
    // the clip, then a song made from it (the JSON's `song`): karaoke and a disco in the player
    slug: "areyouai",
    scene: "areyouai",
    title: "Are you AI?",
    caller: "“ESSEX POLICE”",
    outcome: "The end of 8 minutes he lost.\nA real person, he can assure you.",
  },
  {
    slug: "cold-call",
    scene: "coldcall",
    title: "The cold call",
    caller: "THE SALES REP",
    outcome: "A sales pitch, politely declined.\nNumber off the list.",
  },
  {
    slug: "police-scam",
    scene: "police",
    title: "Police. Again",
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
    const layout = c.req.query("layout");
    if (layout !== undefined && !LAYOUTS.includes(layout as Layout)) return c.text(`layout: one of ${LAYOUTS.join(", ")}`, 400);
    const o = { poster: c.req.query("poster") === "1", layout: layout as Layout | undefined, safe: c.req.query("safe") !== "0" };
    return demo ? c.html(renderPage(base, demo, o)) : c.notFound();
  });
  app.get("/assets/listen.js", async (c) => {
    const body = await d.clientAssets("listen.js");
    return body === undefined
      ? c.notFound()
      : new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  });
  return app;
}

export const BUILD = Date.now().toString(36);
/** The plain pages' <body>: their script (src/web/client/site.ts) reads the base and whether analytics are on. */
export const siteBody = (base: string, analytics?: boolean, cls?: string) =>
  `<body data-base="${esc(base)}"${cls ? ` class="${cls}"` : ""}${analytics ? ` data-analytics="1"` : ""}>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** How the recorder's page lays out the two rooms (src/web/client/listen-scene.ts Layout). */
export type Layout = "wide" | "stack" | "follow";
const LAYOUTS: Layout[] = ["wide", "stack", "follow"];

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
  /** the build, on the media URLs: a deploy's new files miss the browser's and Cloudflare's caches */
  v: string;
  /** the recorder's: the rooms' layout, fixed (else from the frame's shape) */
  layout?: Layout;
  /** the recorder's: keep text off a tall frame's bottom fifth and right edge (Shorts' and Reels' title and buttons) */
  safe?: boolean;
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
  <button class="rc-fs" id="rc-fs" type="button" aria-label="Fullscreen"><svg viewBox="0 0 9 9" aria-hidden="true"><path fill="currentColor" d="M0 0h3v1H1v2H0zM6 0h3v3H8V1H6zM0 6h1v2h2v1H0zM8 6h1v3H6V8h2z"/></svg></button>
  <div class="rc-seek" id="rc-seek"><i id="rc-progress"></i><i id="rc-mark"></i></div>
</div>`;

export const github = `<svg viewBox="0 0 16 16" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.06-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const GITHUB = "https://github.com/szerintedmi/callsitter";

/** "14:26:40": hours, minutes, seconds */
const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s) % 60].map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join(":");

export const head = (title: string, description: string, css: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="${description}">
<meta name="theme-color" content="#0e0d10">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="${favicon}">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jersey+10&family=Pixelify+Sans:wght@500;600&display=swap">
<style>${css}</style>
</head>`;

/**
 * The public pages' top bar (home, /bot, the game at /play): the brand (home), scammer time wasted
 * (#wasted: the game page's script keeps it live), the bot page's button (not on it), GitHub (the
 * home page has it in its footer instead, and the bot page's button in its hero: then the counter
 * sits on the right). `player`: the game page's player chip, first on the right (topCss; public.ts
 * moves it on a phone). `play`: the game's button, on the bot page.
 */
export const top = (base: string, wastedSeconds: number, o: { botLink: boolean; github?: boolean; player?: string; play?: boolean }) => {
  const right = `${o.player ?? ""}${o.botLink ? `<a class="rc-own" href="${base}bot">GET YOUR OWN BOT</a>` : ""}${
    o.play ? `<a class="rc-game" href="${base}play">PLAY THE BOT</a>` : ""
  }${
    o.github === false ? "" : `<a class="rc-gh" href="${GITHUB}" aria-label="CallSitter on GitHub">${github}</a>`
  }`;
  return `<header class="rc-top${right ? "" : " solo"}"><a class="rc-brand" href="${base}">${logo}CALLSITTER</a><p class="rc-wasted">Scammer time wasted: <b id="wasted">${hms(wastedSeconds)}</b></p>${
    right ? `<div class="rc-right">${right}</div>` : ""
  }</header>`;
};

/** The public pages' last line: the terms and the privacy notice (legal.ts; topCss); on the home page, GitHub first. */
export const legal = (base: string, o: { github?: boolean } = {}) => {
  const links = `<a href="${base}terms">Terms</a> · <a href="${base}privacy">Privacy</a>`;
  return o.github
    ? `<footer class="rc-legal rc-foot"><a class="rc-gh" href="${GITHUB}">${github}GitHub</a><span aria-hidden="true">|</span><p>${links}</p></footer>`
    : `<p class="rc-legal">${links}</p>`;
};

/** The home page: the pitch with the bot page and the games (/play), then the recordings. */
export function realCallsPage(
  base: string,
  o: { selected: string; autoplay: boolean; wastedSeconds: number; /** page analytics on (analytics.yaml) */ analytics?: boolean },
): string {
  const config: PlayerConfig = { demos: DEMOS, selected: o.selected, autoplay: o.autoplay, render: false, base, v: BUILD };
  const tabs = DEMOS.map(
    (x, i) =>
      `<a class="rc-tab s-${x.scene}" href="${base}listen/${x.slug}" data-slug="${x.slug}" data-notrack><i>${String(i + 1).padStart(2, "0")}</i>${esc(x.title)}</a>`,
  ).join("");
  return `${head("CallSitter", "Real calls to my phone, answered by CallSitter, the bot that wastes scammers' time.", rootCss + topCss + homeCss + realCallsCss + shapeCss + editCss + prologueCss)}
<body class="home"${o.analytics ? ` data-analytics="1"` : ""}>
<div class="rc-col">
${top(base, o.wastedSeconds, { botLink: false, github: false })}
<main class="rc" id="rc">
  <section class="hero">
    <div><p class="hero-kick">CALL SCREENING. WITH ATTITUDE.</p><h1>LET THE BOT TAKE IT.</h1><p class="hero-sub">My bot answers. Friends get through. Scammers meet their match.</p></div>
    <div class="hero-cta"><a class="hero-own" href="${base}bot">GET YOUR OWN BOT</a><a class="hero-play" href="${base}play"><b>PLAY THE BOT</b><span>Can you fool it?</span></a></div>
  </section>
  <h2 class="rc-h"><b>REAL CALLS.</b><span>Actual recordings from my phone.</span></h2>
  <div class="rc-player">
    <div class="rc-screen" id="rc-screen">${stage}<div class="rc-caption" id="rc-caption"></div><button class="rc-fsx" id="rc-fsx" type="button" aria-label="Exit fullscreen">✕</button></div>
    <nav class="rc-tabs" aria-label="Recordings">${tabs}</nav>
  </div>
</main>
${legal(base, { github: true })}
</div>
<audio id="rc-audio" preload="metadata" playsinline></audio>
<script type="application/json" id="rc-config">${json(config)}</script>
<script src="${base}assets/listen.js?v=${BUILD}"></script>
</body>
</html>`;
}

// The bot page's pixel icons, 12×12: one character per pixel, "." transparent.
const PX: Record<string, string> = { p: "#fff6ec", k: "#0e0d10", d: "#8d8994", a: "#ffb000", r: "#d8281f" };
const ICONS = {
  robot: [".....rr.....", ".....dd.....", "..pppppppp..", "..pppppppp..", ".dpkkppkkpd.", ".dpkkppkkpd.", "..pppppppp..", "..pprrrrpp..", "..pppppppp..", "............", "...aaaaaa...", "..aaaaaaaa.."],
  forward: [".pppppp.....", ".pkkkkp.....", ".pkkkkp..a..", ".pkkkkp..aa.", ".pkkkkpaaaaa", ".pkkkkpaaaaa", ".pkkkkp..aa.", ".pkkkkp..a..", ".pkkkkp.....", ".pppppp.....", ".ppkkpp.....", ".pppppp....."],
  popcorn: ["...pp..pp...", "..pppppppp..", ".ppappppapp.", ".pppppapppp.", ".rrpprrpprr.", ".rrpprrpprr.", ".rrpprrpprr.", "..rpprrppr..", "..rpprrppr..", "..rpprrppr..", "...pprrpp...", "...pprrpp..."],
  plane: ["............", "..........dd", "........dddd", "......dddddd", "...dddddddd.", "ddddddddddd.", "...ddd.ddd..", "....dd.ddd..", "....d..dd...", ".......dd...", "......dd....", "......d....."],
  sliders: ["............", "...dd.......", "dddddddddddd", "...dd.......", "............", "........dd..", "dddddddddddd", "........dd..", "............", ".....dd.....", "dddddddddddd", ".....dd....."],
  transcript: ["..dddddddd..", "..d......d..", "..d.dddd.d..", "..d......d..", "..d.dddd.d..", "..d......d..", "..d.dddd.d..", "..d......d..", "..d.ddd..d..", "..d......d..", "..dddddddd..", "............"],
  phone: ["ddd.........", "dddd........", "dddd........", ".ddd........", "..dd........", "..ddd.......", "...ddd......", "....ddd.....", ".....dddddd.", "......dddddd", "........dddd", ".........ddd"],
};
/** An inline SVG, one rect per run of same-coloured pixels in a row. */
const pixelIcon = (rows: string[]) =>
  `<svg viewBox="0 0 12 12" width="48" height="48" shape-rendering="crispEdges" aria-hidden="true">${rows
    .flatMap((row, y) => [...row.matchAll(/([^.])\1*/g)].map((m) => `<rect x="${m.index}" y="${y}" width="${m[0].length}" height="1" fill="${PX[m[1]!]}"/>`))
    .join("")}</svg>`;

const item = (icon: string[], title: string, text: string) => `<li>${pixelIcon(icon)}<div><b>${title}</b><span>${text}</span></div></li>`;

/** The waitlist's answer to a plain form post (public.ts signup), by its `?waitlist=` outcome: done, or an error under the form. */
const WAITLIST: Record<string, { done?: string; err?: string }> = {
  ok: { done: "THANKS! WE'LL KEEP YOU POSTED." },
  limit: { err: "Too many sign-ups from your network today. Try again tomorrow." },
  email: { err: "That doesn't look like an email." },
};

/**
 * "Get your own bot": not open yet, a waitlist (POST call/waitlist). The home page's top bar, with
 * the game on its right, and its footer. Its script (src/web/client/site.ts) posts the form; without
 * it, the form posts itself and the server sends the visitor back here with `waitlist` (the outcome).
 */
export function botPage(base: string, o: { wastedSeconds: number; /** page analytics on (analytics.yaml) */ analytics?: boolean; waitlist?: string }): string {
  const after = o.waitlist === undefined ? {} : (WAITLIST[o.waitlist] ?? { err: "Something went wrong." });
  return `${head("Get your own bot · CallSitter", "Get CallSitter on your own phone: forward your calls to your own bot, follow them on Telegram. Join the waitlist.", rootCss + topCss + homeCss + botCss)}
${siteBody(base, o.analytics, "own")}
<div class="rc-col">
${top(base, o.wastedSeconds, { botLink: false, github: false, play: true })}
<main class="bot">
  <section class="bot-hero">
    <h1>GET YOUR OWN BOT.</h1>
    <p class="bot-sub"><span>It answers the calls you don't.</span> <span>Scammers waste their time.</span><br><span>Sales calls get a polite no.</span> <span>Real callers leave a message.</span></p>
    <p class="bot-soon">Coming soon. Maybe.</p>
    <form class="wl" id="wl" method="post" action="${base}call/waitlist" novalidate${after.done ? " hidden" : ""}>
      <label class="sr" for="wl-in">Your email</label>
      <input id="wl-in" type="email" name="email" autocomplete="email" inputmode="email" maxlength="254" spellcheck="false" placeholder="Your email" required>
      <button type="submit" id="wl-ok">KEEP ME POSTED</button>
    </form>
    <p class="wl-err" id="wl-err" role="alert"${after.err ? `>${after.err}` : " hidden>"}</p>
    <p class="wl-done" id="wl-done" role="status"${after.done ? `>${after.done}` : ` hidden>${WAITLIST.ok!.done}`}</p>
    <p class="bot-diy">Or set it up yourself: <a href="${GITHUB}">GitHub ↗</a></p>
  </section>
  <section class="bot-sec" aria-labelledby="bot-how">
    <h2 id="bot-how">HOW IT WORKS</h2>
    <ol class="bot-steps">
      ${item(ICONS.robot, "MAKE IT YOURS", "Pick its voice and attitude. It gets its own number.")}
      ${item(ICONS.forward, "FORWARD YOUR CALLS", "All calls, or just the ones you miss. No app.")}
      ${item(ICONS.popcorn, "POPCORN TIME", "Your bot takes the calls. You follow along on Telegram.")}
    </ol>
  </section>
  <ul class="bot-feats" aria-label="What you get">
    ${item(ICONS.plane, "LIVE UPDATES", "Follow every call on Telegram as it happens, with a summary when it ends.")}
    ${item(ICONS.sliders, "STEER IT LIVE", "Tell the bot what to say, how to act, or to hang up, right from Telegram.")}
    ${item(ICONS.phone, "TAKE OVER", "One tap in Telegram puts you on the line.")}
    ${item(ICONS.transcript, "RECORDINGS", "Listen back to every call, with the transcript.")}
  </ul>
</main>
${legal(base, { github: true })}
</div>
<script src="${base}assets/site.js?v=${BUILD}"></script>
</body>
</html>`;
}

function renderPage(base: string, demo: Demo, o: { poster: boolean; layout?: Layout; safe: boolean }) {
  const config: PlayerConfig = { demos: DEMOS, selected: demo.slug, autoplay: false, render: true, ...o, base, site: "callsitter.org", v: BUILD };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(demo.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jersey+10&family=Pixelify+Sans:wght@500;600&display=swap">
<style>${rootCss}${realCallsCss}${shapeCss}${editCss}${prologueCss}
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
export const rootCss = `
:root{color-scheme:dark;--ink:#0e0d10;--ink2:#1b1a20;--line:#2c2a33;--paper:#fff6ec;--dim:#8d8994;--red:#d8281f;--red-hi:#ff5a4e;--grn:#35d07a;--grn-ink:#04230f;--amb:#ffb000;
--disp:"Jersey 10",ui-monospace,monospace;--text:"Pixelify Sans",ui-monospace,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ink);color:var(--paper);font-family:var(--text)}
a:focus-visible,button:focus-visible{outline:3px solid var(--amb);outline-offset:2px}
`;

// The top bar (top()), on every public page, in a column as wide as the home page's: on a
// desktop, the top bar, title, tabs, the 16:9 stage and the PLAY THE BOT button all fit the first
// screen (the stage's width follows the window's height). public.ts includes it for /play.
export const topCss = `
.rc-col{--rc-chrome:318px;width:min(1132px,100% - 32px,max(560px,(100svh - var(--rc-chrome)) * 16 / 9));margin:0 auto}
.rc-top{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px 20px;padding:14px 0 12px;border-bottom:3px solid var(--line)}
.rc-brand{justify-self:start}
.logo{flex:none;width:24px;height:24px}
.rc-brand{display:inline-flex;align-items:center;gap:10px;font-family:var(--disp);font-size:34px;line-height:1;letter-spacing:.03em;color:var(--paper);text-decoration:none}
.rc-wasted{margin:0;text-align:center;font-size:15px;color:var(--dim);white-space:nowrap}
.rc-wasted b{font-family:var(--disp);font-weight:400;font-size:24px;color:var(--amb);font-variant-numeric:tabular-nums;vertical-align:-2px;margin-left:4px}
.rc-right{display:flex;align-items:center;gap:16px;justify-self:end;min-height:37px}
.rc-own{font-family:var(--disp);font-size:22px;line-height:1;letter-spacing:.04em;padding:7px 12px 8px;background:var(--amb);color:var(--ink);text-decoration:none;box-shadow:4px 4px 0 #000;white-space:nowrap}
.rc-own:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 #000}
.rc-gh{color:var(--dim);display:flex}
.rc-legal{margin:0;padding:8px 0 16px;text-align:center;font-family:var(--text);font-size:13px;letter-spacing:0;color:var(--dim)}
.rc-legal a{color:var(--dim);text-decoration:none}.rc-legal a:hover{color:var(--paper);text-decoration:underline}
.rc-gh:hover{color:var(--paper)}
.rc-own:active{transform:translate(2px,2px);box-shadow:2px 2px 0 #000}
.rc-game{font-family:var(--disp);font-size:24px;line-height:1;letter-spacing:.04em;color:var(--paper);text-decoration:none;white-space:nowrap}
.rc-game:hover{color:var(--amb)}
@media (max-width:640px){
.rc-col{width:auto}
.rc-top{display:flex;flex-wrap:wrap;padding:10px 16px 8px}
.rc-right{margin-left:auto;gap:12px;min-height:32px}
.rc-brand{font-size:28px}
.rc-own{font-size:19px;padding:6px 10px 7px}
.rc-game{font-size:20px}
.rc-wasted{order:3;flex-basis:100%;text-align:left;font-size:14px}
.rc-wasted b{font-size:21px}
}
`;

// .rc-h is the bot page's title too; the rest is the home page's: the hero, then the stage with
// the recordings' list on its right (under it on a narrow screen).
const homeCss = `
.rc{padding:0 0 16px}
.rc-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 16px;margin:14px 0 12px;font-weight:400}
.rc-h b{font-family:var(--disp);font-weight:400;font-size:56px;line-height:.85;letter-spacing:.03em;color:var(--amb);text-shadow:3px 3px 0 #000}
.rc-h span{font-size:18px;color:var(--paper)}
.home .rc-col{--side:clamp(240px,24vw,296px);width:min(1132px,100% - 32px)}
.rc-top.solo{grid-template-columns:1fr auto}
.rc-top.solo .rc-wasted{justify-self:end}
.hero{display:grid;grid-template-columns:1fr var(--side);align-items:center;gap:20px 32px;padding:30px 0 0}
.hero-kick{margin:0;font-size:20px;font-weight:600;letter-spacing:.06em;color:var(--dim)}
.hero h1{margin:10px 0 6px;font-family:var(--disp);font-weight:400;font-size:clamp(56px,7.8vw,100px);line-height:.85;letter-spacing:.03em;color:var(--amb);text-shadow:4px 4px 0 #000}
.hero-sub{margin:0;font-size:21px;line-height:1.3}
.hero-cta{display:flex;flex-direction:column;gap:14px}
.hero-own,.hero-play{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;text-decoration:none;line-height:1}
.hero-own{padding:13px 16px 15px;background:var(--amb);color:var(--ink);font-family:var(--disp);font-size:34px;letter-spacing:.04em;box-shadow:5px 5px 0 #000}
.hero-play{padding:10px 16px 12px;color:var(--paper);box-shadow:inset 0 0 0 3px #6b6773}
.hero-play b{font-family:var(--disp);font-weight:400;font-size:30px;letter-spacing:.04em}
.hero-play span{font-size:15px;color:#c8c2cf}
.hero-own:hover{transform:translate(-1px,-1px);box-shadow:6px 6px 0 #000}
.hero-own:active{transform:translate(2px,2px);box-shadow:2px 2px 0 #000}
.hero-play:hover{background:var(--ink2);box-shadow:inset 0 0 0 3px var(--paper)}
.home .rc-h{flex-direction:column;align-items:flex-start;gap:8px;margin:56px 0 16px}
.home .rc-h span{font-size:18px;color:var(--dim)}
.rc-player{display:grid;grid-template-columns:1fr var(--side);gap:19px;align-items:stretch}
.rc-tabs{display:flex;flex-direction:column;box-shadow:0 0 0 3px var(--line)}
.rc-tab{flex:1 1 0;display:flex;align-items:center;gap:20px;min-height:44px;padding:6px 20px;font-size:21px;line-height:1.1;color:#c8c2cf;text-decoration:none}
.rc-tab+.rc-tab{border-top:3px solid var(--line)}
.rc-tab i{flex:none;width:1.3em;font-style:normal;color:var(--dim)}
.rc-tab:hover{color:var(--paper);background:var(--ink2)}
.rc-tab[aria-current]{color:var(--paper);background:var(--ink2);box-shadow:inset 6px 0 0 var(--amb)}
.rc-tab[aria-current] i{color:var(--paper)}
.rc-foot{display:flex;justify-content:flex-end;align-items:center;gap:20px;padding:20px 0 24px}
.rc-foot,.rc-foot a{font-size:15px}
.rc-foot p{margin:0}
.rc-foot .rc-gh{align-items:center;gap:10px;color:var(--dim);text-decoration:none}
.rc-foot .rc-gh svg{width:22px;height:22px}
@media (max-width:860px){
.hero{grid-template-columns:1fr}
.hero-cta{flex-direction:row}
.hero-cta a{flex:1 1 0;justify-content:center}
.rc-player{grid-template-columns:1fr}
.rc-tab{flex:none}
}
@media (max-width:640px){
.rc{padding:0 0 24px}
.rc-h{margin-left:16px;margin-right:16px}
.rc-h{flex-direction:column;gap:6px;margin-top:12px;margin-bottom:12px}
.rc-h b{font-size:48px}
.rc-h span{font-size:15px}
.home .rc-col{padding:0 16px}
.home .rc-top{padding-left:0;padding-right:0;flex-wrap:nowrap;align-items:center}
.rc-top.solo .rc-wasted{order:0;flex:0 1 auto;margin-left:auto;max-width:9.5em;white-space:normal;font-size:12px;line-height:1.3}
.rc-top.solo .rc-wasted b{font-size:16px;margin-left:2px;vertical-align:-1px}
.hero{gap:14px;padding:16px 0 0}
.hero-kick{font-size:15px}
.hero h1{margin:4px 0 8px;font-size:clamp(44px,14vw,64px);text-shadow:3px 3px 0 #000}
.hero-sub{font-size:17px}
.hero-cta{flex-direction:column;gap:10px}
.hero-own{padding:9px 12px 11px;font-size:26px;box-shadow:4px 4px 0 #000}
.hero-play{padding:8px 12px 10px}
.hero-play b{font-size:24px}
.hero-play span{font-size:13px}
.home .rc-h{margin:40px 0 12px;gap:4px}
.home .rc-h b{font-size:44px}
.home .rc-h span{font-size:15px}
.home .rc-stage{box-shadow:0 0 0 3px var(--line)}
.home .rc-caption{padding:10px 0 0}
.rc-player{gap:12px}
.rc-tab{min-height:38px;padding:4px 14px;gap:16px;font-size:17px}
.rc-tab[aria-current]{box-shadow:inset 5px 0 0 var(--amb)}
.rc-foot{justify-content:center;gap:14px;padding:16px 0}
}
`;

// The bot page: a centred hero with the waitlist, the steps in three columns, the features in two
// (all one column on a phone, icons on the left). Its column is the home page's (homeCss).
const botCss = `
.own .rc-col{width:min(1132px,100% - 32px)}
.bot{padding:0 0 8px}
.bot-hero{display:flex;flex-direction:column;align-items:center;max-width:820px;margin:0 auto;padding:clamp(36px,7vh,64px) 0 0;text-align:center}
.bot-hero h1{margin:0 0 18px;font-family:var(--disp);font-weight:400;font-size:clamp(56px,7.8vw,100px);line-height:.85;letter-spacing:.03em;color:var(--amb);text-shadow:4px 4px 0 #000}
.bot p{margin:0}
.bot-sub{font-size:22px;line-height:1.4}
.bot-soon{margin-top:20px!important;font-size:16px;color:var(--dim)}
.wl{display:flex;gap:12px;width:100%;max-width:760px;margin-top:18px}
.wl input{flex:1 1 auto;min-width:0;padding:12px 16px;border:0;border-radius:0;background:var(--ink);color:var(--paper);box-shadow:inset 0 0 0 3px var(--line);font-family:var(--text);font-size:18px}
.wl input::placeholder{color:var(--dim)}
.wl input:focus{outline:0;box-shadow:inset 0 0 0 3px var(--amb)}
.wl button{flex:none;padding:9px 28px 11px;border:0;border-radius:0;background:var(--amb);color:var(--ink);font-family:var(--disp);font-size:30px;line-height:1;letter-spacing:.04em;box-shadow:5px 5px 0 #000;cursor:pointer}
.wl button:hover{transform:translate(-1px,-1px);box-shadow:6px 6px 0 #000}
.wl button:active{transform:translate(2px,2px);box-shadow:2px 2px 0 #000}
.wl button:disabled{cursor:wait}
.wl-err{margin-top:12px!important;color:var(--red-hi);font-size:16px}
.wl-done{margin-top:18px!important;font-family:var(--disp);font-size:34px;line-height:1;letter-spacing:.03em;color:var(--amb)}
.bot-diy{margin-top:20px!important;font-size:16px;color:var(--dim)}
.bot-diy a{color:var(--paper);text-decoration:none;box-shadow:0 2px 0 currentColor}
.bot-diy a:hover{color:var(--amb)}
.bot-sec{margin-top:clamp(48px,8vh,72px)}
.bot-sec h2{margin:0 0 32px;text-align:center;font-family:var(--disp);font-weight:400;font-size:36px;line-height:1;letter-spacing:.05em;color:var(--dim)}
.bot-steps,.bot-feats{margin:0;padding:0;list-style:none;display:grid}
.bot li div{display:flex;flex-direction:column;gap:6px}
.bot li b{font-family:var(--disp);font-weight:400;font-size:28px;line-height:1;letter-spacing:.04em;color:var(--paper)}
.bot li span{font-size:17px;line-height:1.45;color:#c8c2cf}
.bot-steps{grid-template-columns:repeat(3,1fr);gap:32px;counter-reset:step}
.bot-steps li{display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;counter-increment:step}
.bot-steps li span{max-width:17em;text-wrap:balance}
.bot-steps svg{width:72px;height:72px}
.bot-steps b::before{content:counter(step) ". ";color:var(--amb)}
.bot-feats{grid-template-columns:1fr 1fr;gap:36px 48px;margin:clamp(48px,8vh,72px) auto 0;max-width:1000px}
.bot-feats li{display:grid;grid-template-columns:40px 1fr;align-items:start;gap:22px}
.bot-feats svg{width:40px;height:40px;margin-top:2px}
.bot-feats b{font-size:24px}
.bot-feats span{font-size:16px;color:var(--dim)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
[hidden]{display:none!important}
@media (max-width:860px){
.bot-steps{grid-template-columns:1fr;gap:24px}
.bot-steps li{display:grid;grid-template-columns:56px 1fr;align-items:start;gap:20px;text-align:left}
.bot-steps li span{max-width:none;text-wrap:wrap}
.bot-steps svg{width:56px;height:56px}
}
@media (max-width:640px){
.own .rc-col{padding:0 16px}
.own .rc-top{padding-left:0;padding-right:0}
.bot-hero{align-items:stretch;padding-top:28px;text-align:left}
.bot-hero h1{margin-bottom:12px;font-size:clamp(44px,14vw,64px);text-shadow:3px 3px 0 #000}
.bot-sub{font-size:17px}
.bot-sub span{display:block}
.bot-sub br{display:none}
.bot-soon{margin-top:14px!important;font-size:14px}
.wl{flex-direction:column;gap:10px;margin-top:12px}
.wl input{font-size:17px}
.wl button{font-size:26px;box-shadow:4px 4px 0 #000}
.wl-done{font-size:28px}
.bot-diy{text-align:center;font-size:14px}
.bot-sec{margin-top:40px}
.bot-sec h2{margin-bottom:20px;font-size:30px;text-align:left}
.bot-steps{gap:20px}
.bot-steps li{grid-template-columns:48px 1fr;gap:16px}
.bot-steps svg{width:48px;height:48px}
.bot li b{font-size:22px}
.bot li span{font-size:15px}
.bot-feats{grid-template-columns:1fr;gap:20px;margin-top:32px}
.bot-feats li{grid-template-columns:32px 1fr;gap:16px}
.bot-feats svg{width:32px;height:32px}
.bot-feats b{font-size:20px}
.bot-feats span{font-size:14px}
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
[data-scene="areyouai"]{--rc-caller:#6ea8ff}
[data-scene="coldcall"]{--rc-caller:#4fd1c5}
.rc-pop{position:absolute;left:var(--x,0);top:var(--y,0);transform:translate(-50%,-100%) scale(var(--s,0));transform-origin:50% 100%;font-size:max(3.2cqw,16px);line-height:1;padding:.6cqw .9cqw;background:var(--paper);color:var(--ink);border:.25cqw solid #000;box-shadow:.3cqw .3cqw 0 #000;white-space:nowrap;pointer-events:none;font-family:var(--disp);text-align:center}
.rc-pop small{font-size:.55em;display:block;letter-spacing:.04em}
.rc-pop.dumb{background:var(--amb)}
.rc-beep{position:absolute;left:var(--x,0);top:var(--y,0);transform:translate(-50%,-50%) rotate(-8deg) scale(var(--s,0));font-family:var(--disp);font-size:max(3cqw,15px);color:#000;background:var(--amb);padding:.2cqw 1cqw;border:.3cqw solid #000;box-shadow:.4cqw .4cqw 0 #000;pointer-events:none;letter-spacing:.08em}
.rc-banner{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%) scale(var(--s,0));font-family:var(--disp);font-size:max(3cqw,15px);letter-spacing:.06em;padding:.4cqw 1.6cqw;background:var(--red);color:var(--paper);border:.3cqw solid #000;box-shadow:.5cqw .5cqw 0 #000;white-space:nowrap;pointer-events:none}
.rc-banner.ok{background:var(--grn);color:var(--grn-ink)}
.rc-banner .sep,.pl-cap .sep{font-style:normal}
.rc-banner.song,.rc-mode.song{background:#c23bd4;color:var(--paper)}
.rc-subs{position:absolute;left:3cqw;right:3cqw;bottom:3cqw;display:flex;flex-direction:column;gap:.8cqw;pointer-events:none}
.rc-sub{max-width:64%;padding:.8cqw 1.2cqw;font-size:max(1.85cqw,11px);line-height:1.3;font-variant-ligatures:none;background:#0e0d10ee;border:.2cqw solid var(--line);box-shadow:.3cqw .3cqw 0 #000}
.rc-sub i{font-style:normal;color:#6f6a76}
.rc-sub i.on{color:var(--paper)}
.rc-sub i.red{background:var(--amb);color:#000;padding:0 .2em}
.rc-sub i.red:not(.on){background:#5a4a20;color:#0000}
.rc-sub .who{display:block;font-family:var(--disp);font-size:max(1.3cqw,10px);letter-spacing:.06em}
.rc-sub.caller{align-self:flex-start;border-left:.6cqw solid var(--rc-caller,var(--red-hi))}.rc-sub.caller .who{color:var(--rc-caller,var(--red-hi))}
.rc-sub.agent{align-self:flex-end;border-right:.6cqw solid var(--grn)}.rc-sub.agent .who{color:var(--grn);text-align:right}
.rc-sub.both{align-self:center;text-align:center;border-left:.6cqw solid var(--amb);border-right:.6cqw solid var(--amb)}.rc-sub.both .who{color:var(--amb)}
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
/* fullscreen (listen-fullscreen.ts): the button on touch screens, or on hover; the stage and its captions fill the screen, letterboxed */
.rc-fs{position:absolute;right:10px;bottom:30px;width:36px;height:36px;display:grid;place-items:center;padding:7px;background:#0e0d10c0;color:var(--paper);border:2px solid #000;box-shadow:2px 2px 0 #000;cursor:pointer;opacity:0;transition:opacity .2s}
.rc-fs svg{width:100%;height:100%;shape-rendering:crispEdges}
.rc-stage:hover .rc-fs,.rc-fs:focus-visible{opacity:1}
@media (pointer:coarse){.rc-fs{opacity:.85}}
.rc-render .rc-fs,.rc-fsx{display:none}
.rc-screen.fs{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000}
.rc-screen.fs .rc-stage{width:min(100vw,100dvh * 16 / 9);max-height:100dvh;box-shadow:none}
.rc-screen.fs .rc-caption{position:absolute;left:0;right:0;bottom:max(12px,env(safe-area-inset-bottom));padding:0 12px;min-height:0}
.rc-screen.fs .rc-fsx{display:grid;place-items:center;position:absolute;top:max(10px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right));width:44px;height:44px;font:28px/1 var(--disp);background:#0e0d10c0;color:var(--paper);border:2px solid #000;box-shadow:2px 2px 0 #000;cursor:pointer;z-index:2;transition:opacity .4s}
.rc-screen.fs.idle .rc-fsx,.rc-screen.fs.idle .rc-fs{opacity:0}
.rc-fs-on,.rc-fs-on body{overflow:hidden}
@media (max-width:640px){
.rc-stage{box-shadow:none}
.rc-subs{display:none}
.rc-caption{display:block;padding:10px 16px 0;font-size:16px;line-height:1.35}
.rc.playing .rc-caption{min-height:calc(3 * 1.35em + 28px)}
.rc-caption{overflow:hidden;transition:height .25s ease-out;box-sizing:border-box}
.rc-caption .rc-sub+.rc-sub{margin-top:6px}
.rc-caption .rc-sub.old{font-size:14px;padding:5px 10px}
.rc-caption .rc-sub{max-width:none;font-size:16px;padding:8px 12px;border-width:2px}
.rc-caption .rc-sub .who{font-size:14px}
.rc-caption .rc-sub.caller{border-left-width:5px}.rc-caption .rc-sub.agent{border-right-width:5px}
.rc-caption .rc-sub.both{border-left-width:5px;border-right-width:5px}
}
`;

// The recorder's page in a frame other than 16:9 (record.ts --size 1080x1920): listen.ts sets the
// stage's data-shape. Its text is sized up by --z, as it's measured in the frame's width; a tall
// frame shows the latest subtitle alone, at the bottom; with the rooms stacked (the caller's to 42%, the
// bot's from 58%), the subtitles and the stage's banner centred in the band between, and the badge in the
// bot's room. .safe keeps text
// off the bottom (13% in a tall frame) and the right edge, where Shorts, Reels and TikTok put the
// title and buttons; what's centred stays on the frame's middle.
const shapeCss = `
.rc-stage{--z:1;--safe-r:0px;--safe-b:0px}
.rc-stage[data-shape="square"]{--z:1.45}
.rc-stage[data-shape="tall"]{--z:2.2}
.rc-stage.safe{--safe-r:13cqw;--safe-b:20%}
.rc-stage:not([data-shape="wide"]) .rc-mode{right:calc(2cqw + var(--safe-r));top:2.4cqw;font-size:calc(var(--z) * 1.6cqw);padding:calc(var(--z) * .3cqw) calc(var(--z) * 1cqw);border-width:calc(var(--z) * .25cqw);box-shadow:calc(var(--z) * .3cqw) calc(var(--z) * .3cqw) 0 #000}
.rc-stage:not([data-shape="wide"]) .rc-pop{z-index:1;font-size:calc(var(--z) * 2.7cqw);border-width:calc(var(--z) * .25cqw);box-shadow:calc(var(--z) * .3cqw) calc(var(--z) * .3cqw) 0 #000;padding:calc(var(--z) * .6cqw) calc(var(--z) * .9cqw)}
.rc-stage:not([data-shape="wide"]) .rc-beep{font-size:calc(var(--z) * 3cqw);border-width:calc(var(--z) * .3cqw);box-shadow:calc(var(--z) * .4cqw) calc(var(--z) * .4cqw) 0 #000}
.rc-stage:not([data-shape="wide"]) .rc-banner{font-size:calc(var(--z) * 2.6cqw);width:max-content;max-width:92cqw;white-space:normal;text-align:center;border-width:calc(var(--z) * .3cqw);box-shadow:calc(var(--z) * .5cqw) calc(var(--z) * .5cqw) 0 #000}
.rc-stage:not([data-shape="wide"]) .rc-subs{left:3cqw;right:calc(3cqw + var(--safe-r));bottom:calc(3cqw + var(--safe-b));gap:calc(var(--z) * .8cqw)}
.rc-stage:not([data-shape="wide"]) .rc-sub{max-width:92%;font-size:calc(var(--z) * 1.85cqw);padding:calc(var(--z) * .8cqw) calc(var(--z) * 1.2cqw);border-width:calc(var(--z) * .2cqw);box-shadow:calc(var(--z) * .3cqw) calc(var(--z) * .3cqw) 0 #000}
.rc-stage:not([data-shape="wide"]) .rc-sub .who{font-size:calc(var(--z) * 1.3cqw)}
.rc-stage:not([data-shape="wide"]) .rc-sub.caller{border-left-width:calc(var(--z) * .6cqw)}
.rc-stage:not([data-shape="wide"]) .rc-sub.agent{border-right-width:calc(var(--z) * .6cqw)}
.rc-stage:not([data-shape="wide"]) .rc-sub.both{border-left-width:calc(var(--z) * .6cqw);border-right-width:calc(var(--z) * .6cqw)}
.rc-stage:not([data-shape="wide"]) .rc-end{gap:calc(var(--z) * 2cqw);padding:0 4cqw var(--safe-b)}
.rc-stage:not([data-shape="wide"]) .rc-end b{font-size:calc(var(--z) * 3cqw)}
.rc-stage:not([data-shape="wide"]) .rc-end span{font-size:calc(var(--z) * 2.4cqw)}
.rc-stage[data-shape="tall"] .rc-sub.old:has(~ .rc-sub){display:none}
.rc-stage.safe[data-shape="tall"]{--safe-b:13%}
.rc-stage[data-shape="tall"] .rc-sub{font-size:calc(var(--z) * 2.6cqw)}
.rc-stage[data-shape="tall"] .rc-banner{font-size:calc(var(--z) * 3.4cqw);line-height:1.15;padding:calc(var(--z) * .5cqw) calc(var(--z) * 1.8cqw)}
.rc-stage[data-shape="tall"] .rc-banner span{display:block}
.rc-stage[data-shape="tall"] .rc-banner .sep{display:none}
.rc-stage[data-layout="stack"]:not([data-song]) .rc-banner{top:50%;z-index:2;font-size:calc(var(--z) * 3cqw)}
.rc-stage[data-layout="stack"] .rc-mode{top:calc(58% + 2.4cqw);left:2cqw;right:auto;transform-origin:0 0}
.rc-stage[data-layout="stack"] .rc-subs{inset:0;display:block}
.rc-stage[data-layout="stack"] .rc-sub{position:absolute;left:3cqw;right:calc(3cqw + var(--safe-r));max-width:none}
.rc-stage[data-layout="stack"] .rc-sub{bottom:50%;right:auto;width:max-content;max-width:calc(94% - var(--safe-r));transform:translateY(50%)}
.rc-stage[data-layout="stack"] .rc-sub.agent{left:auto;right:calc(3cqw + var(--safe-r))}
.rc-stage[data-layout="stack"] .rc-sub.both{left:50%;transform:translate(-50%,50%)}
.rc-stage[data-layout="stack"][data-banner] .rc-subs{visibility:hidden}
.rc-stage[data-shape="tall"] .rc-endcard{padding:0 6cqw}
`;

// An edit's overlays (src/web/client/listen-edit.ts), over the stage, sized by the frame's --z.
const editCss = `
.rc-edit{position:absolute;inset:0;pointer-events:none;font-family:var(--disp);color:var(--paper)}
.rc-edit>*{position:absolute;opacity:var(--o,1)}
.rc-card{inset:0}
.rc-card.dim{background:#0e0d10c8}
.rc-card b{position:absolute;left:50%;top:var(--y,50%);transform:translate(-50%,-50%) scale(var(--s,1));width:max-content;max-width:calc(88% - var(--safe-r));font-weight:400;font-size:calc(var(--k,1) * var(--z) * 3.8cqw);line-height:1;letter-spacing:.03em;text-align:center;white-space:pre-line;padding:.3em .55em .38em;background:var(--ink);border:calc(var(--z) * .3cqw) solid #000;box-shadow:calc(var(--z) * .6cqw) calc(var(--z) * .6cqw) 0 #000}
.rc-edit em{font-style:normal;color:var(--amb)}
.rc-msg{top:var(--y,42%);left:50%;transform:translate(-50%,-50%) translateY(calc((1 - var(--s,1)) * 80%)) scale(calc(.6 + .4 * var(--s,1)))}
.rc-msg.left{left:calc(var(--z) * 15cqw)}
.rc-msg.right{left:auto;right:calc(var(--z) * 15cqw + var(--safe-r));transform:translate(50%,-50%) translateY(calc((1 - var(--s,1)) * 80%)) scale(calc(.6 + .4 * var(--s,1)))}
.rc-stage[data-shape="tall"] .rc-msg.left,.rc-stage[data-shape="tall"] .rc-msg.right{left:50%;right:auto;transform:translate(-50%,-50%) translateY(calc((1 - var(--s,1)) * 80%)) scale(calc(.6 + .4 * var(--s,1)))}
.rc-phone{position:relative;width:calc(var(--z) * 25cqw);min-height:calc(var(--z) * 15cqw);padding:calc(var(--z) * 2.4cqw) calc(var(--z) * 1.1cqw) calc(var(--z) * 1.6cqw);background:var(--ink);border:calc(var(--z) * .55cqw) solid var(--amb);box-shadow:0 0 0 calc(var(--z) * .3cqw) #000,calc(var(--z) * .9cqw) calc(var(--z) * .9cqw) 0 calc(var(--z) * .3cqw) #000}
.rc-phone-cam{position:absolute;left:50%;top:calc(var(--z) * .8cqw);width:calc(var(--z) * 5cqw);height:calc(var(--z) * .7cqw);transform:translateX(-50%);background:var(--line)}
.rc-phone-top{display:flex;align-items:center;gap:calc(var(--z) * .7cqw);padding:0 0 calc(var(--z) * .7cqw);margin-bottom:calc(var(--z) * 1cqw);border-bottom:calc(var(--z) * .25cqw) solid var(--line);font-size:calc(var(--z) * 1.7cqw);letter-spacing:.06em}
.rc-phone-top i{width:calc(var(--z) * 1.3cqw);height:calc(var(--z) * 1.3cqw);background:var(--grn);box-shadow:inset calc(var(--z) * -.3cqw) calc(var(--z) * -.3cqw) 0 #04230f}
.rc-phone-chat{display:flex;flex-direction:column;align-items:flex-end;gap:calc(var(--z) * .8cqw)}
.rc-bub{position:relative;max-width:88%;padding:calc(var(--z) * .5cqw) calc(var(--z) * .9cqw) calc(var(--z) * .7cqw);background:var(--paper);color:var(--ink);font-family:var(--text);font-size:calc(var(--z) * 1.55cqw);line-height:1.25;transform:scale(var(--s,1));transform-origin:100% 100%;box-shadow:calc(var(--z) * .3cqw) calc(var(--z) * .3cqw) 0 var(--amb)}
.rc-bub::after{content:"";position:absolute;right:calc(var(--z) * -.7cqw);bottom:0;width:calc(var(--z) * .7cqw);height:calc(var(--z) * .7cqw);background:var(--paper)}
.rc-bub small{display:block;font-family:var(--disp);font-size:.8em;letter-spacing:.06em;color:#8a5a00}
.rc-bub span{white-space:pre-line}
.rc-bub em{color:#c42b22}
.rc-typing{display:flex;gap:calc(var(--z) * .45cqw);padding:calc(var(--z) * .7cqw) calc(var(--z) * .9cqw);background:var(--paper)}
.rc-typing i{width:calc(var(--z) * .7cqw);height:calc(var(--z) * .7cqw);background:var(--amb);transform:translateY(calc(var(--h,0) * var(--z) * -.5cqw))}
.rc-clock{display:flex;flex-direction:column;padding:calc(var(--z) * .3cqw) calc(var(--z) * 1cqw) calc(var(--z) * .5cqw);background:var(--ink);border:calc(var(--z) * .25cqw) solid #000;box-shadow:calc(var(--z) * .3cqw) calc(var(--z) * .3cqw) 0 #000;border-left:calc(var(--z) * .6cqw) solid var(--amb);transform:scale(var(--s,1));transform-origin:0 0}
.rc-clock b{font-weight:400;font-size:calc(var(--z) * 3.4cqw);line-height:1;color:var(--amb);font-variant-numeric:tabular-nums;letter-spacing:.04em}
.rc-clock small{font-size:calc(var(--z) * 1.2cqw);letter-spacing:.08em;color:var(--paper)}
.rc-clock.top-left{left:2cqw;top:3cqw}
.rc-clock.top{left:50%;top:3cqw;transform:translateX(-50%) scale(var(--s,1));transform-origin:50% 0;align-items:center}
.rc-clock.top-right{right:calc(2cqw + var(--safe-r));top:3cqw;transform-origin:100% 0;align-items:flex-end}
.rc-endcard{inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--z) * 1.8cqw);padding:0 calc(6cqw + var(--safe-r)) var(--safe-b) 6cqw;background:var(--ink);text-align:center}
.rc-endcard b{font-weight:400;font-size:calc(var(--z) * 6cqw);line-height:.95;color:var(--amb);text-shadow:calc(var(--z) * .4cqw) calc(var(--z) * .4cqw) 0 #000;white-space:pre-line}
.rc-endcard b em{color:var(--paper)}
.rc-endcard span{font-family:var(--text);font-size:calc(var(--z) * 1.9cqw);line-height:1.3;white-space:pre-line}
.rc-endcard u{text-decoration:none;font-size:calc(var(--z) * 2.6cqw);letter-spacing:.08em;padding:calc(var(--z) * .3cqw) calc(var(--z) * 1.4cqw) calc(var(--z) * .5cqw);background:var(--amb);color:var(--ink);box-shadow:calc(var(--z) * .4cqw) calc(var(--z) * .4cqw) 0 #000}
`;

// A demo's prologue (src/web/client/listen-prologue.ts): the owner's phone ringing and, later, texting
// the bot, cards, a tag and the clock (the cards and clock are the edit's, editCss), over the stage
// under its end card. Sized by the frame's --z like the rest; the phone by its own --pz on top.
const prologueCss = `
.rc-pro{position:absolute;inset:0;pointer-events:none;font-family:var(--disp);color:var(--paper);--zs:var(--z,1)}
.rc-pro>*{position:absolute;opacity:var(--o,1)}
.rc-pro em{font-style:normal;color:var(--amb)}
.pl-dim,.pl-black,.pl-siren,.pl-flash{inset:0}
.pl-dim,.pl-black{background:var(--ink)}
.pl-black{opacity:1}
.pl-siren{opacity:1;mix-blend-mode:screen;background:radial-gradient(70% 110% at 0% 50%,rgb(50 100 255 / var(--b,0)),transparent 80%),radial-gradient(70% 110% at 100% 50%,rgb(230 40 30 / var(--r,0)),transparent 80%)}
.pl-flash{background:var(--paper);opacity:var(--o,0);mix-blend-mode:screen}
.pl-cap{left:50%;top:calc((100% - var(--safe-b,0px)) * .915);transform:translate(-50%,-50%);font-size:max(calc(var(--zs) * 2.2cqw),11px);letter-spacing:.14em;white-space:nowrap;opacity:var(--o,0)}
.rc-stage:not([data-shape="wide"]) .pl-cap{top:9%;width:80cqw;white-space:normal;text-align:center;line-height:1.3}
.rc-stage[data-shape="tall"] .pl-cap{top:12%;width:92cqw;font-size:calc(var(--zs) * 3.6cqw);letter-spacing:.1em;line-height:1.25}
.rc-stage[data-shape="tall"] .pl-cap span{display:block}
.rc-stage[data-shape="tall"] .pl-cap .sep{display:none}
.rc-stage[data-shape="tall"] .rc-card.pl-over b{background:none;border:0;box-shadow:none;color:var(--amb);text-shadow:calc(var(--z) * .4cqw) calc(var(--z) * .4cqw) 0 #000}
.rc-stage[data-shape="tall"] .rc-card.pl-left b{left:50%;transform:translate(-50%,-50%) scale(var(--s,1));transform-origin:50% 50%}
.rc-pro .rc-clock b{font-size:max(calc(var(--z) * 3.4cqw),22px)}
.rc-pro .rc-clock small{font-size:max(calc(var(--z) * 1.2cqw),9px)}
@media (max-width:640px){.pl-cap{width:86%;white-space:normal;text-align:center;line-height:1.25;top:93%}}
.rc-card b small{display:block;margin-top:.3em;font-size:.48em;letter-spacing:.04em;color:var(--paper)}
.rc-card.pl-left b{left:4cqw;transform:translate(0,-50%) scale(var(--s,1));transform-origin:0 50%}
.pl-tag{left:2cqw;top:3cqw;display:flex;align-items:center;gap:.45em;padding:calc(var(--zs) * .38cqw) calc(var(--zs) * 1.1cqw) calc(var(--zs) * .5cqw);background:var(--ink);border:calc(var(--zs) * .25cqw) solid #000;box-shadow:calc(var(--zs) * .38cqw) calc(var(--zs) * .38cqw) 0 #000;font-size:max(calc(var(--zs) * 1.9cqw),13px);line-height:1;letter-spacing:.1em}
.pl-tag i{width:.5em;height:.5em;background:var(--red-hi);opacity:var(--o,1)}
.pl-msg{left:50%;top:var(--y,50%);transform:translate(-50%,-50%) translate(var(--dx,0px),0) rotate(var(--r,0deg))}
.pl-msg .rc-phone{--z:calc(var(--zs) * var(--pz,1));width:calc(var(--z) * var(--w,25) * 1cqw);min-height:calc(var(--z) * var(--h,15) * 1cqw);display:flex;flex-direction:column}
.pl-msg .rc-phone-top span{white-space:nowrap}
.pl-msg .rc-phone-top i{flex:none}
.pl-ring{position:absolute;inset:calc(var(--z) * 2.4cqw) calc(var(--z) * 1.1cqw) calc(var(--z) * 1.8cqw);display:flex;flex-direction:column;align-items:center;text-align:center}
.pl-inc{margin-top:calc(var(--z) * .2cqw);font-size:calc(var(--z) * 1.7cqw);letter-spacing:.12em}
.pl-inc i{font-style:normal;color:var(--red-hi)}
.pl-light{order:1;width:calc(var(--z) * 6cqw);margin:auto 0;image-rendering:pixelated;shape-rendering:crispEdges;filter:drop-shadow(calc(var(--z) * .35cqw) calc(var(--z) * .35cqw) 0 #000)}
.pl-id{margin-top:calc(var(--z) * .9cqw);font-size:calc(var(--z) * 5.2cqw);line-height:.86;letter-spacing:.04em;text-shadow:calc(var(--z) * .35cqw) calc(var(--z) * .35cqw) 0 #000;white-space:pre-line}
.pl-btns{order:2;display:flex;justify-content:space-around;width:100%}
.pl-btns i{display:grid;place-items:center;width:calc(var(--z) * 4.6cqw);height:calc(var(--z) * 4.6cqw);border:calc(var(--z) * .25cqw) solid #000;box-shadow:calc(var(--z) * .35cqw) calc(var(--z) * .35cqw) 0 #000;transform:translate(var(--p,0),var(--p,0)) scale(var(--s,1))}
.pl-btns svg{width:58%;shape-rendering:crispEdges}
.pl-no{background:var(--red)}
.pl-yes{background:var(--grn)}
.pl-space{flex-grow:var(--g,0)}
.pl-tick{position:absolute;left:calc(var(--z) * -2.6cqw);bottom:0;width:calc(var(--z) * 1.6cqw);shape-rendering:crispEdges;opacity:var(--o,0)}
.pl-input{display:flex;align-items:center;gap:calc(var(--z) * .45cqw);margin-top:calc(var(--z) * 1cqw * var(--ih,1));max-height:calc(var(--z) * 8cqw * var(--ih,1));overflow:hidden;opacity:var(--ih,1)}
.pl-field{flex:1;min-width:0;min-height:calc(var(--z) * 3cqw);padding:calc(var(--z) * .5cqw) calc(var(--z) * .6cqw);background:var(--ink2);box-shadow:inset 0 0 0 calc(var(--z) * .25cqw) var(--line);font-family:var(--text);font-size:calc(var(--z) * 1.55cqw);line-height:1.25}
.pl-caret{display:inline-block;width:calc(var(--z) * .25cqw);height:1.1em;margin-left:.08em;background:var(--amb);vertical-align:-.18em;opacity:var(--o,1)}
.pl-send{display:grid;place-items:center;flex:none;width:calc(var(--z) * 2.8cqw);height:calc(var(--z) * 2.8cqw);background:var(--amb);box-shadow:calc(var(--z) * .3cqw) calc(var(--z) * .3cqw) 0 #000;transform:scale(var(--s,1))}
.pl-send svg{width:55%;shape-rendering:crispEdges}
.pl-ping{left:var(--x);top:var(--y);width:calc(var(--d,2) * 1cqw);height:calc(var(--d,2) * 1cqw);transform:translate(-50%,-50%);border:.4cqw solid var(--red-hi);box-shadow:0 0 0 .2cqw #000;opacity:var(--o,0)}
.pl-glow{left:var(--x);top:var(--y);width:7cqw;height:7cqw;transform:translate(-50%,-50%);background:radial-gradient(circle,rgb(255 70 50 / .9) 0,rgb(255 60 40 / .35) 25%,transparent 60%);mix-blend-mode:screen;opacity:var(--o,0)}
`;
