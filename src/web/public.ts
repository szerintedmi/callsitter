import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { NO_MEDIA, type CallManager } from "../core/call-manager";
import type { AppConfig } from "../core/config";
import { errMsg } from "../core/orchestrator";
import type { Clock, Repo } from "../core/ports";
import type { CallEvent } from "../core/types";
import type { OpenAiWebRtc, WebRtcAnswer } from "../adapters/openai-live/webrtc";
import { hostOf } from "./admin-guard";
import type { ClientAssets } from "./admin";

// The public "Scam me" page, at the root of the public host (and at /public on the admin host,
// as a preview). The browser talks to Live over WebRTC (adapters/openai-live/webrtc.ts); we only
// swap the SDP and steer the call over a sideband, like an OpenAI SIP call. Anyone with the link
// can call, so PublicGate caps calls per IP, calls at once and the estimated daily spend
// (config/public.yaml).
//
//   POST call                 {sdp} → {callId, sdp} | {error, message}
//   POST call/:id/connected   the page's audio is up: Live says the greeting
//   POST call/:id/hangup      the page hung up (also sent as a beacon when the page closes)
//   GET  call/:id/events      server-sent events: {verdict, lean, stage} as Jev and the
//                             call flow move on (the page shows them), until the call ends

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

/** What the page is sent during a call: Jev's verdict (null while unclear; the page doesn't show it), its lean (the needle) and the stage. */
export interface PublicState {
  verdict: string | null;
  /** -1 (genuine) .. 1 (scam or spam): P(scam) + P(spam) - P(genuine); unclear pulls it to 0 */
  lean: number;
  stage: string | null;
}

/** The state after `ev`, or null if `ev` doesn't change what the page shows. */
export function nextState(prev: PublicState, ev: CallEvent): PublicState | null {
  if (ev.type === "classification") {
    const c = ev.classification;
    const p = c.answers.verdict?.probabilities;
    const verdict = c.answers.verdict?.choice ?? c.verdict;
    const lean = p
      ? (p.scam ?? 0) + (p.spam ?? 0) - (p.genuine ?? 0)
      : verdict === "genuine" ? -c.confidence : verdict === "unclear" ? 0 : c.confidence;
    return { ...prev, verdict: verdict === "unclear" ? null : verdict, lean: Math.max(-1, Math.min(1, lean)) };
  }
  if (ev.type === "stage") return { ...prev, stage: ev.stage.replaceAll("_", " ") };
  return null;
}

/** The most one public call can cost: Live for max_call_seconds plus every Luna call it may make. */
export function worstCaseUsd(cfg: AppConfig): number {
  const secs = Math.min(cfg.public.max_call_seconds, cfg.flow.timing.max_call_seconds);
  return (secs / 60) * cfg.cost.live_usd_per_min + cfg.luna.limits.max_calls * cfg.cost.luna_usd_per_call;
}

export interface PublicDeps {
  manager: CallManager;
  config: () => AppConfig;
  gate: PublicGate;
  webrtc: OpenAiWebRtc;
  clientAssets: ClientAssets;
}

export function publicRoutes(d: PublicDeps) {
  const app = new Hono();
  /** calls waiting for the page to say its audio is up */
  const connected = new Map<string, () => void>();
  /** what each live public call's page shows, and the pages listening */
  const states = new Map<string, { state: PublicState; streams: Set<SSEStreamingApi> }>();

  d.manager.bus.subscribe((ev) => {
    if (!d.gate.isActive(ev.callId)) return;
    const s = states.get(ev.callId);
    // Every call ends up here, however it ended (page, call flow, max length, Live closing).
    if (ev.type === "call.ended") {
      d.gate.release(ev.callId);
      connected.delete(ev.callId);
      states.delete(ev.callId);
      for (const st of s?.streams ?? []) void st.writeSSE({ event: "ended", data: "{}" }).finally(() => st.close());
      return;
    }
    const next = s && nextState(s.state, ev);
    if (!s || !next) return;
    s.state = next;
    for (const st of s.streams) void st.writeSSE({ data: JSON.stringify(next) });
  });

  // Mounted at / (public host) and /public (admin preview): the page's URLs are under its own path.
  app.get("/", (c) => c.html(page(c.req.path.replace(/\/?$/, "/"))));

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
    const s = states.get(c.req.param("id"));
    if (!s) return c.text("no such call", 404);
    return streamSSE(c, async (stream) => {
      s.streams.add(stream);
      stream.onAbort(() => void s.streams.delete(stream));
      await stream.writeSSE({ data: JSON.stringify(s.state) });
      // Bun closes a connection idle for 10 s; Cloudflare after 100 s.
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(5000);
        if (!stream.aborted && !stream.closed) await stream.write(": ping\n\n");
      }
    });
  });

  // Limited before the body is read: the request is anonymous.
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "bad_request", message: "Something went wrong." }, 413) });
  app.post("/call", limit, async (c) => {
    const body = await c.req.json<{ sdp?: unknown }>().catch(() => ({}) as { sdp?: unknown });
    if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=0")) {
      return c.json({ error: "bad_request", message: "Something went wrong." }, 400);
    }
    if (!d.manager.accepting) return c.json({ error: "busy", message: "Back in a minute." }, 503);
    const callId = crypto.randomUUID();
    const ip = c.req.header("cf-connecting-ip");
    const refused = await d.gate.admit(callId, ip ?? "local");
    if (refused) return c.json({ error: refused.error, message: refused.message }, refused.status);
    states.set(callId, { state: { verdict: null, lean: 0, stage: null }, streams: new Set() });

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
              .catch((err) => console.warn(`[call ${callId}] recording not saved: ${errMsg(err)}`))
        : undefined,
    });
    try {
      await d.manager.registerIncoming({ callId, callControlId: `${PREFIX}${callId}`, from: PUBLIC_FROM, to: "public page", callerIp: ip });
    } catch (err) {
      d.gate.release(callId);
      states.delete(callId);
      console.warn(`[public ${callId}] not started: ${errMsg(err)}`);
      return c.json({ error: "busy", message: "Back in a minute." }, 503);
    }
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
      console.log(`[public ${callId}] Live session ${a.sessionId}`);
      return c.json({ callId, sdp: a.sdp });
    } catch (err) {
      console.error(`[public ${callId}] could not start: ${errMsg(err)}`);
      return c.json({ error: "failed", message: "Couldn't connect. Try again." }, 502);
    }
  });

  app.post("/call/:id/connected", (c) => {
    connected.get(c.req.param("id"))?.();
    return c.body(null, 204);
  });

  app.post("/call/:id/hangup", (c) => {
    const id = c.req.param("id");
    if (d.gate.isActive(id)) void d.manager.hangup(id, "hung up on the page");
    return c.body(null, 204);
  });

  return app;
}

/** Changes on every server start, so the page never runs a stale cached script. */
const BUILD = Date.now().toString(36);

const css = `
:root{color-scheme:light dark;--bg:#f6f5f1;--fg:#111;--muted:#8a877f;--line:#d9d6ce;--hot:#e5484d;--meter-genuine:#7f9f80;--meter-scam:#b56d6e}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0c0c0c;--fg:#f2f0ea;--muted:#6f6d67;--line:#2a2927;--hot:#ff6369}}
:root[data-theme="dark"]{--bg:#0c0c0c;--fg:#f2f0ea;--muted:#6f6d67;--line:#2a2927;--hot:#ff6369}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;overflow:hidden;user-select:none}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;width:100%}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
#go{font-size:clamp(28px,8vw,44px);font-weight:600;letter-spacing:-.02em;padding:18px 34px;border:1.5px solid var(--fg);border-radius:999px;transition:transform .15s,background .15s,color .15s}
#cta{display:flex;flex-direction:column;align-items:center;gap:14px}
#sub{margin:0;font-size:15px;color:var(--muted);letter-spacing:.01em}
#go:hover{background:var(--fg);color:var(--bg)}#go:active{transform:scale(.97)}
#orb{position:relative;width:min(56vw,240px);aspect-ratio:1}
#orb i{position:absolute;inset:0;border-radius:50%;will-change:transform}
#orb .me{border:1.5px solid var(--fg);opacity:.35}
#orb .it{background:var(--fg);transform:scale(.18)}
body.connecting #orb .me{transform:scale(.62);opacity:.18}
body.connecting #orb .it{transform:scale(.14);opacity:.45}
body.connecting #orb::after{content:"";position:absolute;inset:19%;border:1.5px solid transparent;border-top-color:var(--fg);border-radius:50%;opacity:.45;animation:connecting 1.8s linear infinite}
@keyframes connecting{to{transform:rotate(360deg)}}
#end{width:64px;height:64px;border-radius:50%;background:var(--hot);color:#fff;display:grid;place-items:center}
#end svg{width:28px;height:28px}
#jev{display:flex;flex-direction:column;align-items:center;gap:10px;width:min(224px,80vw)}
#meter{width:100%;overflow:visible}
#meter .arc{fill:none;stroke:var(--line);stroke-width:1.3}
#meter .zone{fill:none;stroke-width:2}
#meter .genuine{stroke:var(--meter-genuine)}#meter .scam{stroke:var(--meter-scam)}
#meter .tick{stroke:var(--muted);stroke-width:1}
#meter .minor{opacity:.6}
#needle{transform-origin:112px 109px;transition:transform .7s cubic-bezier(.2,.7,.2,1)}
#needle .hand{fill:var(--fg)}
#meter .pivot{fill:var(--bg);stroke:var(--fg);stroke-width:1.3}
.meter-labels{display:flex;justify-content:space-between;align-items:center;width:89.285714%;color:color-mix(in srgb,var(--fg) 65%,var(--bg));font-size:14px;line-height:1;letter-spacing:.06em;text-transform:uppercase}
.meter-labels>span:first-child{transform:translateX(-50%)}.meter-labels>span:last-child{transform:translateX(50%)}
.scam-spam{display:inline-flex;align-items:center;gap:2px}.scam-spam .letters{display:inline-flex;flex-direction:column;align-items:center;gap:4px;min-width:12px;font-size:12px;line-height:1;letter-spacing:0}
#stage{min-height:1.4em;white-space:nowrap;text-align:center;font-size:19px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;margin-top:2px}
@media(prefers-reduced-motion:reduce){#needle{transition:none}body.connecting #orb::after{animation:none}}
#msg{min-height:1.4em;color:var(--muted);text-align:center;max-width:320px}
body.connecting #msg{color:transparent}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`;

/** Twenty-five dial marks, with a longer mark every fourth step. */
const meterTicks = Array.from({ length: 25 }, (_, i) => {
  const angle = Math.PI - i * Math.PI / 24;
  const inner = i % 4 === 0 ? 90 : 96;
  const at = (r: number) => [(112 + r * Math.cos(angle)).toFixed(2), (109 - r * Math.sin(angle)).toFixed(2)];
  const [x1, y1] = at(100), [x2, y2] = at(inner);
  return `<line class="tick${i % 4 === 0 ? "" : " minor"}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}).join("");

const page = (base: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Try to scam an AI call screener.">
<meta name="theme-color" content="#0c0c0c" media="(prefers-color-scheme: dark)">
<title>ScamSitter</title>
<link rel="icon" href="data:,">
<style>${css}</style>
</head>
<body data-base="${base}">
<main>
  <div id="cta"><button id="go" type="button">Scam me</button><p id="sub">or get through to me</p></div>
  <div id="orb" hidden><i class="me"></i><i class="it"></i></div>
  <div id="jev" hidden aria-live="polite">
    <svg id="meter" viewBox="0 0 224 118" aria-hidden="true">
      <path class="arc" d="M12 109 A100 100 0 0 1 212 109"/>
      ${meterTicks}
      <path class="zone genuine" d="M12 109 A100 100 0 0 1 41.2893 38.2893"/>
      <path class="zone scam" d="M182.7107 38.2893 A100 100 0 0 1 212 109"/>
      <g id="needle">
        <path class="hand" d="M112 22 L114 111 L112 123 L110 111 Z"/>
        <circle class="pivot" cx="112" cy="109" r="5.5"/>
      </g>
    </svg>
    <div class="meter-labels"><span>Genuine</span><span class="scam-spam"><span class="sr">Scam or spam</span><span aria-hidden="true">s</span><span class="letters" aria-hidden="true"><span>c</span><span>p</span></span><span aria-hidden="true">am</span></span></div>
    <div id="stage"></div>
  </div>
  <button id="end" type="button" aria-label="Hang up" hidden><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9z"/></svg></button>
  <p id="msg" role="status"></p>
</main>
<audio id="remote" autoplay playsinline></audio>
<script src="${base}assets/public.js?v=${BUILD}"></script>
</body>
</html>`;
