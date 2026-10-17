import { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { logger } from "../core/log";
import { errMsg } from "../core/orchestrator";
import type { OwnerAudioLeg, TakeoverHandle, TakeoverState } from "../core/ports";
import type { ClientAssets } from "./admin";
import { BUILD } from "./listen";

const log = logger("takeover");

// Owner takeover: the page talks to the caller over a socket. Two mounts, one protocol:
// - Telegram (takeoverRoutes): the "Take over" button opens /takeover/<callId> as a Mini App, with
//   its socket at /takeover/ws/<callId>. Webhook-style routes (any host): the admin host sits behind
//   Cloudflare Access, which a Mini App can't pass, so the owner is checked by the Mini App's signed
//   initData instead.
// - Admin (adminTakeoverRoutes): the admin call page's button opens /calls/<callId>/takeover, socket
//   /calls/<callId>/takeover/ws. Mounted only behind adminGuard (app.ts), whose Access JWT (or
//   loopback, ADMIN_AUTH=none) already identifies the owner, so its hello carries no initData.
//
// Protocol (text frames are JSON):
//   page → server   {type:"hello", initData?, resume?} (first; initData on the Telegram mount)
//                   {type:"hangup"} (ends the call at once)
//                   {type:"stats", sentFrames, underruns, mutedMs}: its audio counters (OwnerPageStats),
//                   every few seconds while live and before a hangup
//                   binary frames: the owner's mic (PCM16LE 16 kHz mono, 20 ms)
//   server → page   TakeoverState objects ({type:"connecting"|"live"|"ended"|"error", …})
//                   {type:"resume", token}: what to send as `resume` on a reconnect
//                   binary frames: the caller (PCM16LE 16 kHz mono)
// A rejected hello gets {type:"error", message} and the socket is closed. Closing the socket
// (page closed, network gone) is the owner leaving: handle.ownerLeft(), and the core hangs up
// unless the page reconnects within takeover.reconnect_grace_ms. A reconnect presents its
// `resume` token, since initData goes stale (init_data_max_age_s) long before a call ends; a
// first hello on the Telegram mount needs fresh initData. Either way a new connection replaces
// the old one, even if that one isn't known to be gone yet.

/** no hello within this long: close the socket */
const HELLO_TIMEOUT_MS = 10_000;

/** The CallManager methods the page uses (takeover-contract.md). */
export interface TakeoverManager {
  canTakeOver(callId: string): string | null;
  takeOver(callId: string, leg: OwnerAudioLeg): Promise<TakeoverHandle>;
  resumeTakeover(callId: string, reconnectToken: string, leg: OwnerAudioLeg): TakeoverHandle;
}

interface SocketDeps {
  manager: TakeoverManager;
  upgradeWebSocket: UpgradeWebSocket;
  /** override HELLO_TIMEOUT_MS (tests) */
  helloTimeoutMs?: number;
}

export interface TelegramOwner {
  /** Telegram user id from valid, fresh Mini App initData (src/core/telegram-auth.ts), or null */
  verifyInitData: (initData: string) => Promise<{ userId: number } | null>;
  /** the only Telegram user allowed to take calls over (TELEGRAM_CHAT_ID, a private chat) */
  ownerUserId: number;
}

export interface TakeoverRoutesDeps extends SocketDeps, TelegramOwner {
  clientAssets: ClientAssets;
}

/**
 * Who may say hello: `telegram` checks the hello's initData; `admin` trusts the request, so it is
 * only for routes behind adminGuard (adminTakeoverRoutes).
 */
type OwnerCheck = ({ kind: "telegram" } & TelegramOwner) | { kind: "admin" };

type ClientMsg =
  | { type: "hello"; initData?: unknown; resume?: unknown }
  | { type: "hangup" }
  | { type: "stats"; sentFrames?: unknown; underruns?: unknown; mutedMs?: unknown };

/** a page counter, or 0 if it isn't one */
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

const js = (body: string) => new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });

/** The Telegram Mini App mount (any host): every first hello needs the owner's fresh initData. */
export function takeoverRoutes(d: TakeoverRoutesDeps) {
  const app = new Hono();

  app.get("/takeover/:callId", (c) => c.html(page("telegram"), 200, { "Cache-Control": "no-store" }));
  // The page script and the audio worklet it shares with the test-call page.
  for (const name of ["takeover.js", "test-call-worklet.js"])
    app.get(`/assets/${name}`, async (c) => {
      const body = await d.clientAssets(name);
      return body === undefined ? c.notFound() : js(body);
    });
  app.get("/takeover/ws/:callId", takeoverSocket(d, { kind: "telegram", verifyInitData: d.verifyInitData, ownerUserId: d.ownerUserId }));
  return app;
}

/**
 * The admin call page's mount. No initData: ONLY mount this behind adminGuard, which has already
 * checked the Access JWT (or loopback). Its scripts come from the admin host's /assets/.
 */
export function adminTakeoverRoutes(d: SocketDeps) {
  const app = new Hono();
  app.get("/calls/:callId/takeover", (c) => c.html(page("admin"), 200, { "Cache-Control": "no-store" }));
  app.get("/calls/:callId/takeover/ws", takeoverSocket(d, { kind: "admin" }));
  return app;
}

function takeoverSocket(d: SocketDeps, owner: OwnerCheck) {
  return d.upgradeWebSocket((c) => {
    const callId = c.req.param("callId")!;
    let state: "waiting" | "checking" | "attached" | "closed" = "waiting";
    // A function, so TypeScript doesn't narrow `state` across the hello's awaits.
    const closed = () => state === "closed";
    let handle: TakeoverHandle | undefined;
    let hungUp = false;
    let helloTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (ws: WSContext, data: string | Uint8Array<ArrayBuffer>) => {
      if (state !== "closed" && ws.readyState === 1) ws.send(data);
    };
    const reject = (ws: WSContext, message: string) => {
      send(ws, JSON.stringify({ type: "error", message } satisfies TakeoverState));
      ws.close();
    };

    const leg = (ws: WSContext): OwnerAudioLeg => ({
      sendAudio: (pcm16) => send(ws, new Uint8Array(pcm16.buffer as ArrayBuffer, pcm16.byteOffset, pcm16.byteLength)),
      notify: (s) => send(ws, JSON.stringify(s)),
      close: () => ws.close(),
    });

    const attached = (ws: WSContext, h: TakeoverHandle) => {
      if (state === "closed") {
        // The page went away while the takeover started.
        h.ownerLeft();
        return;
      }
      handle = h;
      state = "attached";
      send(ws, JSON.stringify({ type: "resume", token: h.reconnectToken }));
      log.info("owner attached", { callId });
      if (hungUp) hangup();
    };

    const hello = async (ws: WSContext, initData: unknown, resume: unknown) => {
      state = "checking";
      clearTimeout(helloTimer);
      if (typeof resume === "string" && resume) {
        try {
          return attached(ws, d.manager.resumeTakeover(callId, resume, leg(ws)));
        } catch (err) {
          // Replaced or ended: fresh initData (or the admin login) may still let the owner back in.
          log.info(`resume refused (${errMsg(err)}); ${owner.kind === "telegram" ? "trying initData" : "taking over afresh"}`, { callId });
        }
      }
      if (owner.kind === "telegram") {
        const user = typeof initData === "string" && initData ? await owner.verifyInitData(initData) : null;
        if (!user) {
          log.warn("hello rejected: invalid or stale initData", { callId });
          return reject(ws, "This link has expired: open it again from the Telegram button.");
        }
        if (user.userId !== owner.ownerUserId) {
          log.warn("hello rejected: not the owner", { callId, userId: user.userId });
          return reject(ws, "Only the owner can take calls over.");
        }
      }
      // The page went away while its login was checked: don't take the call from the agent.
      if (closed()) {
        log.info("page closed before the takeover started: the agent keeps the call", { callId });
        return;
      }
      const why = d.manager.canTakeOver(callId);
      if (why) return reject(ws, why);
      attached(ws, await d.manager.takeOver(callId, leg(ws)));
    };
    // At the carrier too (the session's hangup, not the "phone leg is gone" stop).
    const hangup = () => {
      log.info("owner hung up", { callId });
      handle!.hangUp();
    };

    return {
      onOpen(_evt, ws) {
        helloTimer = setTimeout(() => {
          if (state === "waiting") reject(ws, "no hello");
        }, d.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
      },
      onMessage(evt, ws) {
        if (typeof evt.data !== "string") {
          if (state !== "attached" || !(evt.data instanceof ArrayBuffer)) return;
          // PCM16LE; an odd trailing byte can't be a sample.
          handle!.ownerAudio(new Int16Array(evt.data, 0, evt.data.byteLength >> 1));
          return;
        }
        let msg: ClientMsg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (msg.type === "hello" && state === "waiting") {
          hello(ws, msg.initData, msg.resume).catch((err) => {
            log.error("takeover failed to start", { callId, err });
            reject(ws, errMsg(err));
          });
        } else if (msg.type === "hangup" && !hungUp && (state === "checking" || state === "attached")) {
          // Ends the call now (no reconnect grace); the core then sends {type:"ended"} and
          // closes. Sent while the takeover is still starting: hang up once it has.
          hungUp = true;
          if (state === "attached") hangup();
        } else if (msg.type === "stats" && state === "attached") {
          handle!.pageStats({ sentFrames: count(msg.sentFrames), underruns: count(msg.underruns), mutedMs: count(msg.mutedMs) });
        }
      },
      onClose() {
        clearTimeout(helloTimer);
        const was = state;
        state = "closed";
        if (was === "attached") {
          if (!hungUp) log.info("owner page disconnected", { callId });
          handle!.ownerLeft();
        }
      },
    };
  });
}

/**
 * The takeover page: in Telegram, Telegram's script, then ours (src/web/client/takeover.ts);
 * `admin` has no Telegram script and tells the script so (data-mode). Colours come from
 * Telegram's theme variables, with fallbacks for a plain browser.
 */
function page(mode: "telegram" | "admin") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Take over call</title>
${mode === "telegram" ? `<script src="https://telegram.org/js/telegram-web-app.js"></script>\n` : ""}<style>
:root{color-scheme:light dark;--bg:var(--tg-theme-bg-color,#fff);--fg:var(--tg-theme-text-color,#1a1a1a);--hint:var(--tg-theme-hint-color,#6b6b6b);
--btn:var(--tg-theme-button-color,#2f6fdb);--btn-fg:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#f1f1f1);--danger:var(--tg-theme-destructive-text-color,#d63b30)}
@media (prefers-color-scheme:dark){:root{--bg:var(--tg-theme-bg-color,#151515);--fg:var(--tg-theme-text-color,#eee);--hint:var(--tg-theme-hint-color,#999);--card:var(--tg-theme-secondary-bg-color,#232323)}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,sans-serif;-webkit-user-select:none;user-select:none}
main{min-height:var(--tg-viewport-stable-height,100vh);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
padding:calc(24px + var(--tg-safe-area-inset-top,0px)) 16px calc(24px + var(--tg-safe-area-inset-bottom,0px));text-align:center}
#status{font-size:20px;font-weight:600;min-height:1.4em}
#timer{font-variant-numeric:tabular-nums;font-size:40px;font-weight:300;letter-spacing:.02em}
.hint{color:var(--hint);font-size:14px;max-width:320px}
button{font:inherit;border:0;border-radius:14px;padding:16px 20px;cursor:pointer;touch-action:manipulation}
button:disabled{opacity:.5;cursor:default}
#start{background:var(--btn);color:var(--btn-fg);font-size:20px;font-weight:600;width:min(320px,100%);padding:22px}
.row{display:flex;gap:12px;width:min(320px,100%)}
.row button{flex:1}
#mute{background:var(--card);color:var(--fg)}
#mute[aria-pressed=true]{background:var(--fg);color:var(--bg)}
#hangup{background:var(--danger);color:#fff;font-weight:600}
[hidden]{display:none!important}
</style>
</head>
<body data-mode="${mode}">
<main>
<div id="status">Take over this call</div>
<div id="timer" hidden>0:00</div>
<button id="start" hidden>Take over</button>
<div class="row" id="controls" hidden><button id="mute" aria-pressed="false">Mute</button><button id="hangup">Hang up</button></div>
<p class="hint" id="hint">Use earphones, so the caller doesn't hear themselves.</p>
</main>
<script src="/assets/takeover.js?v=${BUILD}"></script>
</body>
</html>`;
}
