import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { NO_MEDIA, type CallManager } from "../core/call-manager";
import type { AppConfig } from "../core/config";
import { GAMES, START, goalMet, nextPlay, playSummary, playerName, rankIn, scoreOf, type BoardEntry, type Game, type PlayState } from "../core/game";
import { logger } from "../core/log";
import { errMsg } from "../core/orchestrator";
import type { Clock, Referee, Repo } from "../core/ports";
import { GoalWatch } from "../core/referee";
import type { OpenAiWebRtc, WebRtcAnswer } from "../adapters/openai-live/webrtc";
import { hostOf } from "./admin-guard";
import type { ClientAssets } from "./admin";
import { DEMOS, findDemo, github, realCallsPage } from "./listen";

// The public game page, at the root of the public host (and at /public on the admin host, as a
// preview), or at /play when the real call recordings (listen.ts) take the root: two games (config/games.yaml, src/core/game.ts). "Scam me": the visitor plays a
// scammer who starts the scam and keeps it going, best without getting caught; "Get through":
// they play a real caller and try to get their message through fast. A referee (src/core/referee.ts) judges
// the goal; the call itself is handled like any other. The browser talks to Live over WebRTC (adapters/openai-live/webrtc.ts);
// we only swap the SDP and steer the call over a sideband, like an OpenAI SIP call. Anyone with
// the link can call, so PublicGate caps calls per IP, calls at once and the estimated daily spend
// (config/public.yaml).
//
//   GET  play                 the games, when realCalls (/ is then the recordings, and
//                             listen/:slug opens them on one)
//   GET  call/lobby           the lobby: goals, leaderboards and scammer time wasted (under
//                             call/ because the tunnel routes that on the public host)
//   POST call                 {sdp, game, goal, player} → {callId, sdp, elapsedMs} | {error, message}
//   POST call/:id/connected   the page's audio is up: Live says the greeting
//   POST call/:id/hangup      the page hung up (also sent as a beacon when the page closes)
//   GET  call/:id/events      server-sent events: PlayState as Jev and the call flow move on,
//                             until the call ends
//   GET  call/:id/result      the game's score, rank and leaderboard once the call has ended

const log = logger("public");

/** Call-control ids of public calls. Their Live session ends when the sideband closes it. */
const PREFIX = "web:";
export const isPublicCall = (callControlId: string) => callControlId.startsWith(PREFIX);
/** The caller shown in the call list, and how the budget finds public calls. */
export const PUBLIC_FROM = "public";

const DAY_MS = 24 * 60 * 60 * 1000;
/** an SDP offer is a few KB; a request much bigger isn't one */
const MAX_BODY_BYTES = 64 * 1024;

export type Refusal = { status: 429 | 503; error: "closed" | "busy" | "limit" | "budget"; message: string };

/** Admission for public calls: per-IP, concurrency and a rolling 24 h budget. */
export class PublicGate {
  private active = new Set<string>();
  /** call start times by client IP (in memory: a restart resets it) */
  private byIp = new Map<string, number[]>();

  constructor(private d: { repo: Repo; config: () => AppConfig; clock: Clock }) {}

  /** Reserves a slot for `callId`, or says why not. Call `release` once the call has ended. */
  async admit(callId: string, ip: string): Promise<Refusal | null> {
    const cfg = this.d.config();
    const p = cfg.public;
    const now = this.d.clock.now();
    if (!p.enabled) return { status: 503, error: "closed", message: "Closed for now." };
    const recent = (this.byIp.get(ip) ?? []).filter((t) => t > now - DAY_MS);
    if (recent.length) this.byIp.set(ip, recent);
    else this.byIp.delete(ip); // only IPs that called in the last 24 h are kept
    if (recent.length >= p.per_ip_per_day) return { status: 429, error: "limit", message: "That's enough scamming for today." };
    if (this.active.size >= p.max_concurrent) return { status: 503, error: "busy", message: "All lines are busy. Try again in a few minutes." };

    // Reserved before the await, so concurrent requests see this one; undone if it's refused.
    this.active.add(callId);
    this.byIp.set(ip, [...recent, now]);
    let admitted = false;
    try {
      const ended = await this.d.repo.listCallsFrom(PUBLIC_FROM, now - DAY_MS);
      const spent = ended.reduce((sum, c) => sum + (c.status === "ended" ? (c.costUsd ?? 0) : 0), 0);
      if (spent + this.active.size * worstCaseUsd(cfg) > p.daily_usd) {
        return { status: 503, error: "budget", message: "Out of scams for today. Come back tomorrow." };
      }
      admitted = true;
      return null;
    } finally {
      if (!admitted) this.unreserve(callId, ip, now);
    }
  }

  private unreserve(callId: string, ip: string, at: number) {
    this.active.delete(callId);
    const times = this.byIp.get(ip) ?? [];
    times.splice(times.indexOf(at), 1);
    if (!times.length) this.byIp.delete(ip);
  }

  isActive(callId: string) {
    return this.active.has(callId);
  }

  release(callId: string) {
    this.active.delete(callId);
  }
}


/**
 * The most one public call can cost: Live for max_call_seconds plus every Luna call it may make,
 * including the owner's rolling summaries (luna.yaml progress; counted even without Telegram).
 */
export function worstCaseUsd(cfg: AppConfig): number {
  const secs = Math.min(cfg.public.max_call_seconds, cfg.flow.timing.max_call_seconds);
  const progress = cfg.luna.progress.enabled ? Math.ceil((secs * 1000) / cfg.luna.progress.min_interval_ms) : 0;
  return (secs / 60) * cfg.cost.live_usd_per_min + (cfg.luna.limits.max_calls + progress) * cfg.cost.luna_usd_per_call;
}

/** What the page starts from (embedded in it, and refreshed from GET call/lobby after a call). */
export interface Lobby {
  games: Record<Game, { id: string; name: string; brief: string; hard: boolean; intro?: string }[]>;
  /** each goal's leaderboard: its top `size` scores (games.yaml leaderboard_size), a player's several too */
  boards: Record<Game, Record<string, BoardEntry[]>>;
  size: number;
  /** scam: each second before being caught counts this many times (games.yaml) */
  undetectedMultiplier: number;
  /** SCAMMER TIME WASTED: seconds so far on calls judged scam or spam (public ones too), and how many are live now */
  wasted: { seconds: number; live: number };
}

/** A game once its call has ended (GET call/:id/result). */
export interface GameResult {
  game: Game;
  goal: string;
  player: string;
  /** null: never started the scam (scam); message never passed on, or caught first (get_through) */
  scoreMs: number | null;
  /** the call's length */
  durationMs: number | null;
  rank: number | null;
  board: BoardEntry[];
}

export interface PublicDeps {
  manager: CallManager;
  repo: Repo;
  /** judges the game calls' goals (games.yaml referee) */
  referee: Referee;
  config: () => AppConfig;
  gate: PublicGate;
  webrtc: OpenAiWebRtc;
  clientAssets: ClientAssets;
  /** the real call recordings as the home page (listen.ts), /listen/<slug>, and the games at /play */
  realCalls?: boolean;
}

const JUNK = ["scam", "spam"];

export function publicRoutes(d: PublicDeps) {
  const app = new Hono();
  /** calls waiting for the page to say its audio is up */
  const connected = new Map<string, () => void>();
  /** each live public call's game and what its page shows, and the pages listening */
  const plays = new Map<string, { game: Game; goal: string; player: string; state: PlayState; watch: GoalWatch; streams: Set<SSEStreamingApi> }>();
  /** ended game calls whose score isn't saved yet (the referee's last look) */
  const settling = new Set<string>();
  const push = (p: { state: PlayState; streams: Set<SSEStreamingApi> }) => {
    for (const st of p.streams) void st.writeSSE({ data: JSON.stringify(p.state) });
  };
  /** live calls (public ones too), for the time-wasted counter; `scamGame`: counts whatever Jev says */
  const liveCalls = new Map<string, { startedAt: number; junk: boolean; scamGame: boolean }>();

  d.manager.bus.subscribe((ev) => {
    if (ev.type === "call.started") {
      const scamGame = plays.get(ev.callId)?.game === "scam";
      liveCalls.set(ev.callId, { startedAt: ev.meta.startedAt, junk: scamGame, scamGame });
    }
    const lc = liveCalls.get(ev.callId);
    // Like the call row's verdict, which counts the call once it has ended (repo.junkCallSeconds).
    if (lc && ev.type === "classification") lc.junk = lc.scamGame || JUNK.includes(ev.classification.verdict);
    if (ev.type === "call.ended") liveCalls.delete(ev.callId);

    if (!d.gate.isActive(ev.callId)) return;
    const p = plays.get(ev.callId);
    // Every call ends up here, however it ended (page, call flow, max length, Live closing).
    if (ev.type === "call.ended") {
      d.gate.release(ev.callId);
      connected.delete(ev.callId);
      plays.delete(ev.callId);
      for (const st of p?.streams ?? []) void st.writeSSE({ event: "ended", data: "{}" }).finally(() => st.close());
      // The referee's last look first, so a goal met in the last words still counts.
      if (p) {
        settling.add(ev.callId);
        void p.watch
          .final()
          .then(async () => {
            const multiplier = d.config().games.scam.undetected_multiplier;
            await d.repo.finishPlay(ev.callId, scoreOf(p.game, p.state, ev.at, multiplier), Date.now());
            // On the call's log and the server's, so a missing score can be explained.
            const line = `game ${p.game}/${p.goal} ${p.player}: ${playSummary(p.game, p.state, ev.at, multiplier)}`;
            log.info(line, { callId: ev.callId });
            await d.manager.note(ev.callId, "info", line);
          })
          .catch((err) => log.warn("game not finished", { callId: ev.callId, err }))
          .finally(() => settling.delete(ev.callId));
      }
      return;
    }
    if (!p) return;
    if (ev.type === "transcript") {
      // The referee reads only final transcripts, so it judges each caller line as it arrives.
      p.watch.add(ev.entry);
      if (ev.entry.final && ev.entry.speaker === "caller" && ev.entry.text) p.watch.check();
      return;
    }
    const next = nextPlay(p.state, ev, d.config().games);
    if (!next) return;
    p.state = next;
    push(p);
  });

  async function lobby(): Promise<Lobby> {
    const g = d.config().games;
    const boards = { scam: {}, get_through: {} } as Lobby["boards"];
    for (const game of GAMES) {
      for (const goal of g[game].goals) boards[game][goal.id] = (await d.repo.scores(game, goal.id)).slice(0, g.leaderboard_size);
    }
    const now = Date.now();
    const live = [...liveCalls.values()].filter((c) => c.junk);
    const liveSeconds = live.reduce((sum, c) => sum + (now - c.startedAt) / 1000, 0);
    return {
      games: { scam: g.scam.goals, get_through: g.get_through.goals },
      boards,
      size: g.leaderboard_size,
      undetectedMultiplier: g.scam.undetected_multiplier,
      wasted: { seconds: Math.round((await d.repo.junkCallSeconds()) + liveSeconds), live: live.length },
    };
  }

  // Mounted at / (public host) and /public (admin preview): the page's URLs are under its own path.
  const game = async (base: string) => page(base, await lobby(), d.config().public.phone_number, d.realCalls);
  if (d.realCalls) {
    const home = async (base: string, slug?: string) =>
      realCallsPage(base, {
        selected: slug ?? DEMOS[0]!.slug,
        autoplay: slug !== undefined,
        wastedSeconds: (await lobby()).wasted.seconds,
        phone: d.config().public.phone_number,
      });
    app.get("/", async (c) => c.html(await home(c.req.path.replace(/\/?$/, "/"))));
    app.get("/play", async (c) => c.html(await game(c.req.path.slice(0, c.req.path.lastIndexOf("play")))));
    // a recording's link (the README's): the page, on that call, playing
    app.get("/listen", (c) => c.redirect(c.req.path.slice(0, c.req.path.indexOf("listen"))));
    app.get("/listen/:slug", async (c) => {
      const slug = c.req.param("slug");
      return findDemo(slug) ? c.html(await home(c.req.path.slice(0, c.req.path.indexOf("listen/")), slug)) : c.notFound();
    });
  } else app.get("/", async (c) => c.html(await game(c.req.path.replace(/\/?$/, "/"))));
  app.get("/call/lobby", async (c) => c.json(await lobby(), 200, { "Cache-Control": "no-store" }));

  app.get("/assets/public.js", async (c) => {
    const body = await d.clientAssets("public.js");
    return body === undefined
      ? c.notFound()
      : new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  });

  // POSTs only from this page: another site's script can't start calls on a visitor's behalf.
  const sameOrigin: MiddlewareHandler = async (c, next) => {
    const origin = c.req.header("origin");
    const host = hostOf(c.req.header("host"));
    if (!origin || !URL.canParse(origin) || !host || hostOf(new URL(origin).host) !== host) return c.text("forbidden", 403);
    await next();
  };
  app.use("/call", sameOrigin);
  app.post("/call/*", sameOrigin);

  // The call id is the capability: only the page that started the call knows it.
  app.get("/call/:id/events", (c) => {
    const p = plays.get(c.req.param("id"));
    if (!p) return c.text("no such call", 404);
    return streamSSE(c, async (stream) => {
      p.streams.add(stream);
      stream.onAbort(() => void p.streams.delete(stream));
      await stream.writeSSE({ data: JSON.stringify(p.state) });
      // Bun closes a connection idle for 10 s; Cloudflare after 100 s.
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(5000);
        if (!stream.aborted && !stream.closed) await stream.write(": ping\n\n");
      }
    });
  });

  app.get("/call/:id/result", async (c) => {
    const play = await d.repo.getPlay(c.req.param("id"));
    if (!play) return c.text("no such call", 404);
    const call = await d.repo.getCall(play.callId);
    // Not settled yet (still on, or being scored); a call cut off by a restart ends without a score.
    if (play.finishedAt === null && (call?.status !== "ended" || settling.has(play.callId))) return c.json({ pending: true }, 202);
    const scores = await d.repo.scores(play.game, play.goal);
    const result: GameResult = {
      game: play.game,
      goal: play.goal,
      player: play.player,
      scoreMs: play.scoreMs,
      durationMs: call?.endedAt ? call.endedAt - call.startedAt : null,
      rank: play.scoreMs === null ? null : rankIn(play.game, scores, play.scoreMs),
      board: scores.slice(0, d.config().games.leaderboard_size),
    };
    return c.json(result, 200, { "Cache-Control": "no-store" });
  });

  // Limited before the body is read: the request is anonymous.
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "bad_request", message: "Something went wrong." }, 413) });
  app.post("/call", limit, async (c) => {
    type Body = { sdp?: unknown; game?: unknown; goal?: unknown; player?: unknown };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const games = d.config().games;
    const game = GAMES.find((g) => g === body.game);
    const goal = game && games[game].goals.find((g) => g.id === body.goal);
    if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=0") || !game || !goal) {
      return c.json({ error: "bad_request", message: "Something went wrong." }, 400);
    }
    const player = playerName(body.player);
    if (!player) return c.json({ error: "name", message: "Pick another name." }, 400);
    if (!d.manager.accepting) return c.json({ error: "busy", message: "Back in a minute." }, 503);
    const callId = crypto.randomUUID();
    const ip = c.req.header("cf-connecting-ip");
    const refused = await d.gate.admit(callId, ip ?? "local");
    if (refused) return c.json({ error: refused.error, message: refused.message }, refused.status);
    // Event times count from here (the call's start), so the page can set its clock by them.
    const startedAt = Date.now();
    const play = {
      game,
      goal: goal.id,
      player,
      state: START,
      streams: new Set<SSEStreamingApi>(),
      watch: new GoalWatch({
        referee: d.referee,
        game,
        goal,
        config: () => d.config().games.referee,
        onMet: (line) => {
          play.state = goalMet(play.state, game, line);
          push(play);
        },
        // On the call's log (the admin call page), for tuning games.yaml.
        onJudged: (answers) =>
          d.manager.bus.publish({
            type: "note",
            callId,
            at: Date.now() - startedAt,
            level: "info",
            message: `referee: ${Object.entries(answers).map(([q, p]) => `${q} ${p.toFixed(2)}`).join(" · ")}`,
          }),
        onError: (err) => log.warn("referee failed", { callId, err }),
      }),
    };
    plays.set(callId, play);

    const cfg = d.config();
    let answered!: (a: WebRtcAnswer) => void;
    const answer = new Promise<WebRtcAnswer>((r) => (answered = r));
    // Greet once the page can hear it; WebRTC connects after the answer is back.
    const greetAfter = new Promise<void>((r) => {
      connected.set(callId, r);
      setTimeout(r, cfg.public.greeting_wait_ms);
    });
    const voice = d.webrtc.voiceAgent(body.sdp, {
      onAnswer: answered,
      greetAfter,
      onRecording: cfg.connection.sip.record
        ? (wav) =>
            void d.manager
              .saveRecording(callId, wav, "wav")
              .catch((err) => logger("call").warn("recording not saved", { callId, err }))
        : undefined,
    });
    try {
      await d.manager.registerIncoming({ callId, callControlId: `${PREFIX}${callId}`, from: PUBLIC_FROM, to: "public page", callerIp: ip });
    } catch (err) {
      d.gate.release(callId);
      plays.delete(callId);
      log.warn("not started", { callId, err });
      return c.json({ error: "busy", message: "Back in a minute." }, 503);
    }
    // Without its game row the call still works; it just isn't scored.
    await d.repo
      .createPlay({ callId, game, goal: goal.id, player, createdAt: startedAt })
      .catch((err) => log.warn("game not saved", { callId, err }));
    // attachMedia creates the Live session (voice.connect) and runs the call; on failure it
    // ends the call, which releases the slot.
    const attached = d.manager.attachMedia(callId, NO_MEDIA, "pcm24", {
      voice,
      mediaViaVoice: true,
      dryRun: !cfg.public.tools,
      maxCallSeconds: cfg.public.max_call_seconds,
    });
    try {
      const a = await Promise.race([answer, attached.then(() => answer)]);
      log.info("Live session started", { callId, liveSession: a.sessionId });
      return c.json({ callId, sdp: a.sdp, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      log.error("could not start", { callId, err: errMsg(err) });
      return c.json({ error: "failed", message: "Couldn't connect. Try again." }, 502);
    }
  });

  app.post("/call/:id/connected", (c) => {
    connected.get(c.req.param("id"))?.();
    return c.body(null, 204);
  });

  app.post("/call/:id/hangup", (c) => {
    const id = c.req.param("id");
    if (d.gate.isActive(id)) void d.manager.hangup(id, "hung up on the page", "caller");
    return c.body(null, 204);
  });

  return app;
}

/** Changes on every server start, so the page never runs a stale cached script. */
const BUILD = Date.now().toString(36);


// An arcade game-select screen: the scammer-time-wasted scoreboard on top, then a red half (Scam
// me) and a green half (Get through). Fonts: Jersey 10 (display), Pixelify Sans (text).
const css = `
:root{color-scheme:dark;--ink:#0e0d10;--ink2:#1b1a20;--line:#2c2a33;--paper:#fff6ec;--dim:#8d8994;
--red:#d8281f;--red-hi:#ff5a4e;--red-dk:#7d110b;--grn:#35d07a;--grn-ink:#04230f;--grn-hi:#5fe08a;--amb:#ffb000;
--m:var(--red);--m-fg:var(--paper);--m-hi:var(--red-hi);--m-shade:rgba(0,0,0,.2);
--disp:"Jersey 10",ui-monospace,monospace;--text:"Pixelify Sans",ui-monospace,monospace}
body[data-mode="get_through"]{--m:var(--grn);--m-fg:var(--grn-ink);--m-hi:var(--grn-hi);--m-shade:rgba(4,35,15,.12)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;height:100dvh;background:var(--ink);color:var(--paper);font-family:var(--text);display:flex;flex-direction:column;overflow:hidden;user-select:none}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}
button:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--amb);outline-offset:2px}
canvas.sprite{image-rendering:pixelated;display:block;flex:none;height:auto}
@keyframes blink{50%{opacity:0}}
@keyframes pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
@keyframes inL{from{transform:translateX(-36px);opacity:0}to{transform:none;opacity:1}}
@keyframes inR{from{transform:translateX(36px);opacity:0}to{transform:none;opacity:1}}
#app{flex:1;min-height:0;position:relative}
.scr{position:absolute;inset:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden}
.band{flex:none;display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 16px;padding-top:max(10px,env(safe-area-inset-top));background:var(--ink);color:var(--paper);position:relative}
.band h1{margin:0;font-family:var(--disp);font-weight:400;font-size:clamp(28px,5vh,40px);line-height:1;letter-spacing:.03em}
.band h1 button{font:inherit;letter-spacing:inherit}
.band .back{position:absolute;left:12px;bottom:10px;font-family:var(--disp);font-size:28px;padding:0 10px}
.chip{font-family:var(--disp);font-size:22px;line-height:1;letter-spacing:.06em;padding:5px 9px 6px;color:var(--amb);box-shadow:inset 0 0 0 2px var(--line);white-space:nowrap}
.chip small{font-size:18px;color:var(--dim);margin-right:6px}
.chip:hover{box-shadow:inset 0 0 0 2px var(--amb)}
.band .chip{position:absolute;right:12px;bottom:8px}
.hero{flex-direction:column;gap:clamp(6px,1.4vh,12px);text-align:center}
.hero .chip{top:max(10px,env(safe-area-inset-top));bottom:auto}
.hero p{margin:0}
.tagline{font-family:var(--disp);font-size:clamp(22px,3.6vh,36px);line-height:1;letter-spacing:.04em;text-wrap:balance}
.wasted{display:flex;flex-direction:column;align-items:center;gap:4px}
.wasted b{font-family:var(--disp);font-weight:400;font-size:clamp(44px,9vh,96px);line-height:.85;color:var(--amb);font-variant-numeric:tabular-nums;text-shadow:0 0 24px rgba(255,176,0,.25)}
.wasted span{font-family:var(--disp);font-size:clamp(16px,2.4vh,20px);letter-spacing:.06em;line-height:1;color:var(--dim)}
#s-home:not(:has(.split[data-active])) .hero{padding-bottom:calc(clamp(22px,3.4vh,28px) + 28px)}
#s-home:has(.split[data-active]) .hero :is(.tagline,.wasted){display:none}
/* the header when the recordings are the home page: the same as theirs (listen.ts) */
.ptop{justify-content:space-between;align-items:flex-start;padding:12px max(16px,calc((100% - 1100px) / 2)) calc(clamp(22px,3.4vh,28px) + 22px)}
#s-home:has(.split[data-active]) .ptop{padding-bottom:10px}
.pbrand{font-family:var(--disp);font-size:clamp(28px,4vw,40px);line-height:1;letter-spacing:.03em;color:var(--paper);text-decoration:none}
.pwasted{margin:4px 0 0;font-size:14px;color:var(--dim)}
.pwasted b{font-family:var(--disp);font-weight:400;font-size:20px;color:var(--amb);font-variant-numeric:tabular-nums}
.pright{display:flex;align-items:center;gap:14px}
.ptop .chip{position:static}
.gh{color:var(--dim);display:flex}.gh:hover{color:var(--paper)}
.dial{flex-wrap:wrap;column-gap:14px;row-gap:2px;line-height:1}
.dial span{color:var(--dim);letter-spacing:.06em}
.dial a{color:var(--amb);text-decoration:none;white-space:nowrap;font-variant-numeric:tabular-nums;-webkit-user-select:text;user-select:text}
.dial a:hover{text-decoration:underline}
#s-home:has(.split[data-active]) .dial{display:none}
.foot{font-family:var(--disp);font-size:clamp(20px,3.4vh,26px);letter-spacing:.04em;padding:10px 16px;padding-bottom:max(10px,env(safe-area-inset-bottom));text-align:center}
.board{list-style:none;margin:0;padding:8px 14px;width:100%;font-family:var(--disp);font-variant-numeric:tabular-nums;font-size:clamp(20px,3.1vh,24px);line-height:1;letter-spacing:.05em;text-align:left;background:var(--m-shade)}
.board li{display:grid;grid-template-columns:2.4ch 1fr auto;gap:12px;align-items:baseline;padding:3px 4px}
.board .r{opacity:.6}.board .t{text-align:right}
.board li.empty{opacity:.4}
.board li.you{background:var(--ink);color:var(--amb)}
.board li.you .r{opacity:1}
.board li.blinky .n,.board li.blinky .t{animation:blink 1.1s steps(2) infinite}
.btn{font-family:var(--disp);font-size:clamp(28px,4.6vh,36px);line-height:1;padding:10px 34px 12px;background:var(--ink);color:var(--paper);box-shadow:4px 4px 0 rgba(0,0,0,.25)}
.btn:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 rgba(0,0,0,.25)}
.btn:active{transform:translate(2px,2px);box-shadow:1px 1px 0 rgba(0,0,0,.25)}
.btn.ghost{background:transparent;color:var(--m-fg);box-shadow:inset 0 0 0 3px var(--m-fg)}
.split{flex:1;min-height:0;display:flex;position:relative}
.half{--bg:var(--red);--fg:var(--paper);--hi:var(--red-hi);--shade:rgba(0,0,0,.22);flex:1 1 50%;min-width:0;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:clamp(8px,1.8vh,16px);padding:16px;background:var(--bg);color:var(--fg);text-align:center;cursor:pointer;position:relative;overflow:hidden;transition:flex-basis .45s cubic-bezier(.2,.8,.2,1),flex-grow .45s}
.half.get_through{--bg:var(--grn);--fg:var(--grn-ink);--hi:var(--grn-hi);--shade:rgba(4,35,15,.12)}
.half h2{margin:0;font-family:var(--disp);font-weight:400;font-size:clamp(46px,min(10vw,10vh),96px);line-height:.85;text-shadow:3px 3px 0 rgba(0,0,0,.18)}
.half.get_through h2{text-shadow:none}
.half .goal{margin:0;font-size:clamp(18px,2.8vh,22px);font-weight:600;text-wrap:balance}
.half .tap{font-family:var(--disp);font-size:clamp(20px,3.2vh,26px);animation:blink 1.1s steps(2) infinite}
.half canvas.sprite{width:clamp(56px,13vh,126px)}
.half .board{--m-shade:var(--shade)}
.half.get_through .board li.you{color:var(--grn-hi)}
.half .x{position:absolute;top:10px;right:12px;font-family:var(--disp);font-size:26px;padding:2px 8px}
.detail{display:flex;flex-direction:column;align-items:center;gap:clamp(8px,1.6vh,14px);width:100%;max-width:360px}
.detail .how{margin:0 0 clamp(4px,1vh,10px);font-size:clamp(15px,2.3vh,18px);font-weight:600;line-height:1.3;max-width:30ch;text-wrap:balance}
.detail .lbl{margin-bottom:calc(-1 * clamp(2px,.8vh,8px));font-family:var(--disp);font-size:clamp(18px,2.8vh,22px);line-height:1;letter-spacing:.05em;opacity:.75}
.ask{position:absolute;left:50%;top:0;transform:translate(-50%,-50%);z-index:2;margin:0;padding:7px 16px 9px;background:var(--amb);color:var(--ink);box-shadow:5px 5px 0 rgba(0,0,0,.28);font-family:var(--disp);font-size:clamp(22px,3.4vh,28px);line-height:1;letter-spacing:.04em;text-align:center;white-space:nowrap;pointer-events:none}
.split:not([data-active]) .detail,.split:not([data-active]) .x{display:none}
.split[data-active] .ask{display:none}
.split[data-active] .half{flex:0 0 72px;padding:8px}
.split[data-active] .half.on{flex:1 1 100%;padding:16px;cursor:default}
.split[data-active] .half.on .tap,.split[data-active] .half.on .goal,.split[data-active] .half.on canvas.sprite{display:none}
.split[data-active] .half.on h2{font-size:clamp(40px,7vh,64px)}
.split[data-active] .half:not(.on)>:not(h2){display:none}
.split[data-active] .half:not(.on) h2{font-size:34px;writing-mode:vertical-rl;transform:rotate(180deg)}
.split:not([data-active]) .half{padding-top:56px}
.car{display:grid;grid-template-columns:44px 1fr 44px;align-items:stretch;width:100%;touch-action:pan-y}
.car-arr{font-family:var(--disp);font-size:34px;line-height:1;display:grid;place-items:center}
.car-arr:hover{background:var(--shade)}
.card{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:clamp(104px,15vh,120px);padding:10px 8px;background:var(--ink);color:var(--paper)}
.card.inL{animation:inL .22s ease-out}.card.inR{animation:inR .22s ease-out}
.card-top{display:flex;align-items:center;gap:8px}
.card b{font-family:var(--disp);font-weight:400;font-size:clamp(28px,4.4vh,34px);line-height:.9;letter-spacing:.03em;color:var(--hi);text-transform:uppercase}
.card p{margin:0;font-size:clamp(14px,2.2vh,16px);font-weight:500;line-height:1.3;max-width:30ch}
.hard{font-family:var(--disp);font-size:17px;line-height:1;padding:2px 6px 3px;background:var(--amb);color:var(--ink)}
.dots{display:flex}
.dots button{width:20px;height:20px;padding:6px;background:var(--shade);background-clip:content-box}
.dots button:hover{background-color:var(--fg)}
.dots button.on{background-color:var(--fg)}
@media (max-width:700px){
.split{flex-direction:column}
.hero{gap:6px}
.tagline{font-size:20px}
.wasted b{font-size:clamp(40px,6.5vh,56px)}
.split:not([data-active]){flex:1 0 auto}
.split:not([data-active]) .half{flex:1 0 auto;gap:clamp(4px,1.2vh,10px)}
.split:not([data-active]) .half.scam{padding-top:44px}
.split:not([data-active]) .half.get_through{padding-top:16px}
.half canvas.sprite{width:clamp(44px,8vh,80px)}
.split[data-active] .half{flex-basis:52px}
.split[data-active] .half:not(.on) h2{writing-mode:horizontal-tb;transform:none;font-size:30px}
}
.modebg{background:var(--m);color:var(--m-fg)}
.overlay{z-index:5}
.stage{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:clamp(12px,2.8vh,26px);padding:16px;text-align:center;width:100%;max-width:460px;margin-inline:auto}
.tag{display:inline-block;font-family:var(--disp);font-size:22px;line-height:1;padding:5px 10px 6px;background:var(--ink);color:var(--m-hi);letter-spacing:.03em;text-transform:uppercase}
.stage h2{margin:0;font-family:var(--disp);font-weight:400;font-size:clamp(44px,8vh,68px);line-height:.9}
body[data-mode="scam"] .modebg h2{text-shadow:3px 3px 0 rgba(0,0,0,.18)}
.slots{display:flex;gap:clamp(10px,3vw,18px);position:relative}
.slot{display:flex;flex-direction:column;align-items:center;gap:4px}
.slot .ar{font-size:20px;line-height:1;padding:8px 16px;opacity:.75}
.slot .ar:hover{opacity:1}
.ch{display:grid;place-items:center;width:clamp(66px,11vh,86px);height:clamp(78px,13vh,102px);background:var(--m-shade);font-family:var(--disp);font-size:clamp(66px,11vh,90px);line-height:1;border-bottom:6px solid currentColor;cursor:text;position:relative}
.ch.cur{border-bottom-color:var(--ink)}
.ch.cur.empty::after{content:"";position:absolute;left:25%;right:25%;bottom:10px;height:10px;background:var(--m-fg);animation:blink 1s steps(2) infinite}
#name-in{position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px}
.cbar{flex:none;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;padding-top:max(12px,env(safe-area-inset-top))}
.cbrand{font-family:var(--disp);font-size:24px;letter-spacing:.03em;color:var(--dim)}
.cstage{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:clamp(22px,5vh,48px);padding:0 16px 20px;padding-bottom:max(20px,env(safe-area-inset-bottom));width:100%;max-width:440px;margin-inline:auto;text-align:center}
.mission{width:100%;position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 14px 26px;margin-bottom:14px;background:var(--ink2);box-shadow:inset 0 0 0 3px var(--m);color:var(--paper);text-align:center}
.mtab{position:absolute;left:50%;top:100%;transform:translate(-50%,-50%);font-family:var(--disp);font-size:clamp(22px,3.6vh,28px);line-height:1;letter-spacing:.04em;padding:5px 14px 6px;background:var(--m);color:var(--m-fg);white-space:nowrap;text-transform:uppercase}
.mission b{font-family:var(--disp);font-weight:400;font-size:clamp(32px,5.4vh,42px);line-height:.9;letter-spacing:.03em;color:var(--m-hi);text-transform:uppercase}
.mission p{margin:0;font-size:clamp(15px,2.3vh,17px);font-weight:500;line-height:1.3;max-width:32ch}
.mission.solid{background:var(--m);color:var(--m-fg);animation:pop .4s}
.mission.warn{--m:var(--red);--m-fg:var(--paper);--m-hi:var(--red-hi)}
.mission.solid b{color:var(--m-fg)}
.mission.solid .mtab{background:var(--ink);color:var(--m-hi);box-shadow:inset 0 0 0 2px var(--m)}
.mission.solid .hard{display:none}
.clock{display:flex;flex-direction:column;align-items:center;gap:6px}
.clock .lbl{font-family:var(--disp);font-size:clamp(22px,3.6vh,28px);line-height:1;letter-spacing:.05em;color:var(--dim)}
.clock b{font-family:var(--disp);font-weight:400;font-size:clamp(96px,24vh,200px);line-height:.8;color:var(--amb);text-shadow:0 0 24px rgba(255,176,0,.3);font-variant-numeric:tabular-nums}
.cnum{display:flex;align-items:flex-end;justify-content:center;gap:12px}
.cside{display:flex;flex-direction:column;align-items:flex-start;gap:clamp(6px,1.4vh,12px);padding-bottom:.1em}
.cside .pts{font-family:var(--disp);font-size:clamp(32px,6vh,48px);line-height:.8;color:var(--amb)}
#s-call.caught .cside .pts{color:var(--red-hi)}
@keyframes throb{50%{transform:rotate(-6deg) scale(1.12)}}
.xb{font-family:var(--disp);font-size:clamp(40px,7.5vh,64px);line-height:1;padding:2px 12px 6px;transform:rotate(-6deg);background:var(--red);color:var(--paper);box-shadow:0 0 0 3px var(--paper),5px 5px 0 3px rgba(0,0,0,.35);animation:throb 1s ease-in-out infinite}
.xb:empty{display:none}
.clock b.pts-mode[data-len="4"]{font-size:min(150px,34vw,18vh)}
.clock b.pts-mode[data-len="5"]{font-size:min(120px,27vw,15vh)}
.clock b.msg{font-size:clamp(40px,min(11vw,7vh),60px);line-height:1;color:var(--paper);text-shadow:none;text-align:center;text-wrap:balance;text-transform:uppercase}
body.connecting .clock .lbl{animation:blink 1.1s steps(2) infinite}
body.connecting .clock b{opacity:.35}
.meter{width:100%;display:flex;flex-direction:column;gap:8px}
.mbar{display:grid;grid-template-columns:repeat(8,1fr) 4px repeat(8,1fr);gap:4px;align-items:center}
.mbar i{height:clamp(16px,2.6vh,22px);background:var(--ink2)}
.mbar .mid{height:calc(clamp(16px,2.6vh,22px) + 10px);background:var(--paper)}
.mbar i.g{background:var(--grn)}.mbar i.s{background:var(--red-hi)}
.mlbl{display:flex;justify-content:space-between;font-family:var(--disp);font-size:20px;letter-spacing:.06em;line-height:1}
.mlbl span:first-child{color:var(--grn-hi)}.mlbl span:last-child{color:var(--red-hi)}
#s-call.caught #c-lbl,#s-call.caught .clock b{color:var(--red-hi)}
#s-call.caught .clock b{text-shadow:0 0 24px rgba(255,90,78,.35)}
#s-call.reached .clock .lbl,#s-call.reached .clock b{color:var(--grn-hi)}
#s-call.reached .clock b{text-shadow:0 0 24px rgba(95,224,138,.3)}
#s-call.reached .meter{display:none}
.hang{margin-top:clamp(0px,3vh,32px);width:clamp(60px,9vh,72px);height:clamp(60px,9vh,72px);border-radius:50%;background:var(--red);color:#fff;display:grid;place-items:center;box-shadow:0 4px 0 var(--red-dk);flex:none}
.hang svg{width:48%;height:48%}
.hang:active{transform:translateY(3px);box-shadow:0 1px 0 var(--red-dk)}
.banner{position:absolute;left:0;right:0;top:36%;z-index:3;text-align:center;font-family:var(--disp);font-size:clamp(64px,15vw,120px);line-height:.9;color:var(--paper);background:var(--red);padding:14px 16px 18px;animation:pop .45s cubic-bezier(.2,.9,.3,1.3);pointer-events:none}
.banner.good{background:var(--grn);color:var(--grn-ink);font-size:clamp(52px,12vw,100px)}
.r-score{display:flex;flex-direction:column;align-items:center;gap:6px}
.r-score .r-lbl{letter-spacing:.05em;opacity:.7}
.r-score span:empty{display:none}
#r-rank{white-space:pre-line}
.r-score b.wait{animation:blink 1.1s steps(2) infinite}
.r-score b{font-family:var(--disp);font-weight:400;font-size:clamp(76px,15vh,128px);line-height:.8;font-variant-numeric:tabular-nums}
.r-score span{font-family:var(--disp);font-size:clamp(22px,3.6vh,28px);letter-spacing:.04em;text-transform:uppercase;text-align:center;text-wrap:balance}
.r-extra{margin:0;display:flex;align-items:center;gap:10px;padding:6px 12px;background:var(--ink);color:var(--amb);font-family:var(--disp);font-size:clamp(20px,3.2vh,24px);letter-spacing:.03em}
.r-extra canvas.sprite{width:18px}
.r-btns{display:flex;flex-wrap:wrap;justify-content:center;gap:12px}
.r-btns .btn.ghost{font-size:clamp(22px,3.6vh,28px);padding:10px 18px 12px}
.toast{position:absolute;left:50%;top:calc(64px + env(safe-area-inset-top));transform:translateX(-50%);z-index:9;max-width:calc(100% - 32px);padding:10px 16px 12px;background:var(--ink);color:var(--paper);box-shadow:inset 0 0 0 2px var(--amb),5px 5px 0 rgba(0,0,0,.3);font-family:var(--disp);font-size:24px;letter-spacing:.03em;text-align:center}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

const hangIcon = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9z"/></svg>`;

/** JSON inside a <script> element: "<" escaped so no string can close it. */
const scriptJson = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");

const half = (game: Game, title: string, goal: string, sprite: string) => `
      <div class="half ${game}" data-game="${game}" role="button" tabindex="0" aria-label="${title}">
        <button class="x" type="button" aria-label="Back">✕</button>
        <canvas class="sprite" data-sprite="${sprite}" width="24" height="24"></canvas>
        <h2>${title}</h2>
        <p class="goal">${goal}</p>
        <span class="tap">TAP TO PLAY</span>
        <div class="detail" data-detail="${game}"></div>
      </div>`;

const page = (base: string, lobby: Lobby, phone: string, realCalls?: boolean) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Scam my phone's AI, or get through to me. Every game helps it waste real scammers' time.">
<meta name="theme-color" content="#0e0d10">
<title>ScamSitter</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jersey+10&family=Pixelify+Sans:wght@500;600&display=swap">
<style>${css}</style>
</head>
<body data-base="${base}" data-mode="scam" class="idle">
<div id="app">
  <section class="scr" id="s-home">
${
  realCalls
    ? `    <header class="band ptop">
      <div><a class="pbrand" href="${base}" title="Real call recordings">SCAMSITTER</a><p class="pwasted">scammers' time wasted: <b id="wasted">0:00:00</b></p></div>
      <div class="pright"><button class="chip" type="button" data-chip hidden></button><a class="gh" href="https://github.com/szerintedmi/scamsitter" aria-label="ScamSitter on GitHub">${github}</a></div>
    </header>`
    : `    <header class="band hero">
      <h1><button type="button" data-home>SCAMSITTER</button></h1><button class="chip" type="button" data-chip hidden></button>
      <p class="tagline">WASTE THE TIME OF SCAMMERS WHO CALL YOU</p>
      <p class="wasted"><b id="wasted">0:00:00</b><span>SCAMMER TIME WASTED SO FAR</span></p>
    </header>`
}
    <div class="split" id="split">
      <p class="ask">CAN YOU FOOL THE BOT<br>THAT ANSWERS MY PHONE?</p>${half("scam", "SCAM ME", "Be the scammer. Don't get caught.", "bandit")}${half("get_through", "GET THROUGH", "Be a real caller. Reach me fast.", "caller")}
    </div>${phone ? `
    <footer class="band foot dial"><span>OR CALL THE BOT FROM YOUR PHONE</span><a href="tel:${phone.replaceAll(" ", "")}" id="dial" draggable="false">${phone}</a></footer>` : ""}
  </section>

  <section class="scr callbg" id="s-call" hidden>
    <header class="cbar"><span class="cbrand">SCAMSITTER</span><button class="chip" type="button" data-chip></button></header>
    <div class="cstage">
      <div class="mission" id="mission"><span class="mtab" id="m-tab"></span><span class="card-top"><b id="m-name"></b><span class="hard" id="m-hard" hidden>HARD</span></span><p id="m-brief"></p></div>
      <div class="clock"><span class="lbl" id="c-lbl">CALLING…</span><div class="cnum"><b id="c-time">00:00</b><span class="cside" id="c-side" hidden><span class="xb" id="c-x"></span><span class="pts">PTS</span></span></div></div>
      <div class="meter" id="meter"><div class="mbar" id="mbar" aria-hidden="true"></div><div class="mlbl"><span>GENUINE</span><span>SCAM</span></div></div>
      <button class="hang" type="button" id="end" aria-label="Hang up">${hangIcon}</button>
    </div>
    <div class="banner" id="banner" hidden></div>
  </section>

  <section class="scr modebg" id="s-result" hidden>
    <header class="band"><h1><button type="button" data-home>SCAMSITTER</button></h1><button class="chip" type="button" data-chip hidden></button></header>
    <div class="stage">
      <h2 id="r-title"></h2>
      <div class="r-score"><span class="r-lbl" id="r-lbl" hidden></span><b id="r-time"></b><span id="r-rank"></span></div>
      <p class="r-extra" id="r-extra" hidden><canvas class="sprite" data-sprite="sparkle" width="9" height="9"></canvas><span id="r-wasted"></span><canvas class="sprite" data-sprite="sparkle" width="9" height="9"></canvas></p>
      <ol class="board" id="r-board"></ol>
      <div class="r-btns"><button class="btn" type="button" id="again">PLAY AGAIN</button><button class="btn ghost" type="button" id="menu">CHANGE GAME</button></div>
    </div>
    <footer class="band foot">PLAY NOW. REAL SCAMMERS PAY LATER.</footer>
  </section>

  <section class="scr modebg overlay" id="s-name" hidden>
    <header class="band"><button class="back" type="button" id="name-x" aria-label="Close">✕</button><h1><button type="button" data-home>SCAMSITTER</button></h1></header>
    <div class="stage">
      <span class="tag" id="name-tag"></span>
      <h2>PLAYER NAME</h2>
      <div class="slots" id="slots"><input id="name-in" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Your initials"></div>
      <button class="btn" type="button" id="name-ok">CALL ▸</button>
    </div>
  </section>

  <div class="toast" id="msg" role="status" hidden></div>
</div>
<audio id="remote" autoplay playsinline></audio>
<script type="application/json" id="lobby">${scriptJson(lobby)}</script>
<script src="${base}assets/public.js?v=${BUILD}"></script>
</body>
</html>`;
