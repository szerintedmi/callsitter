import { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { b64decode, b64encode } from "../core/audio";
import type { CallManager } from "../core/call-manager";
import type { CallSession } from "../core/call-session";
import { logger } from "../core/log";
import { errMsg } from "../core/orchestrator";
import type { MediaChannel, Telephony } from "../core/ports";
import { StereoRecorder } from "../core/wav";
import { sipUri, type OpenAiSip } from "../adapters/openai-live/sip";
import { isSipCall, sipSessionId, TEST_HEADER, testDial, type BrowserSipCalls } from "./openai-sip";
import { isPublicCall } from "./public";
import { TEST_CALL_PROTOCOL } from "./test-call-protocol";

const log = logger("test call");

// Browser test call: the UI streams the computer mic over a WebSocket instead of a phone leg.
// The server runs an ordinary CallSession (Live, Jev, call flow, Luna); only the media
// channel and hangup differ. The call is recorded as a stereo WAV (mic left, Live's audio right). Audio is 16 kHz PCM16 little-endian, which Live takes natively
// (codec "l16" → audio/pcm 16000), so nothing is transcoded.
//
// Protocol (text frames are JSON):
//   browser → server  {type:"start", dryRun, protocol}   {type:"hangup"}   {type:"underrun"} (playback ran dry)
//                     binary frames: mic audio (PCM16LE 16 kHz)
//   server → browser  {type:"started", callId}  {type:"event", event:CallEvent}  {type:"clear"}
//                     {type:"error", message}   binary frames: agent audio (PCM16LE 16 kHz)

const PREFIX = "browser:";
/** keep the socket open after the call ends so call.ended and the Luna summary still reach the page */
const CLOSE_GRACE_MS = 20_000;

/** Open browser calls by call-control id, so a call-flow/Luna hangup can close the socket. */
export class BrowserCalls {
  private open = new Map<string, () => void>();

  static isBrowser(callControlId: string) {
    return callControlId.startsWith(PREFIX);
  }

  register(callControlId: string, close: () => void) {
    this.open.set(callControlId, close);
  }

  unregister(callControlId: string) {
    this.open.delete(callControlId);
  }

  async hangup(callControlId: string) {
    const close = this.open.get(callControlId);
    this.open.delete(callControlId);
    close?.();
  }
}

/** Sends hangups for browser calls to the socket, OpenAI SIP calls to OpenAI, and everything else to the carrier. */
export function routeTelephony(carrier: Telephony, browser: BrowserCalls, sip?: Pick<OpenAiSip, "hangup">): Telephony {
  return {
    hangup: async (ccid) => {
      if (BrowserCalls.isBrowser(ccid)) return browser.hangup(ccid);
      // The page's WebRTC leg is Live's own: closing the session (the sideband) ends it.
      if (isPublicCall(ccid)) return;
      if (isSipCall(ccid)) {
        if (!sip) throw new Error("OpenAI SIP is not configured");
        return sip.hangup(sipSessionId(ccid));
      }
      return carrier.hangup(ccid);
    },
  };
}

class BrowserMediaChannel implements MediaChannel {
  private closed = false;

  constructor(
    private ws: WSContext,
    private graceMs: number,
    private recorder: StereoRecorder,
    private onClosed: () => void,
  ) {}

  sendAudio(payloadB64: string) {
    if (this.closed) return;
    const bytes = b64decode(payloadB64);
    this.recorder.addAgent(bytes, Date.now());
    this.ws.send(bytes);
  }

  clear() {
    if (!this.closed) this.ws.send(JSON.stringify({ type: "clear" }));
  }

  /** Stops audio now; the socket closes after the grace period (or when the page closes it). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
    setTimeout(() => this.ws.close(), this.graceMs);
  }
}

/** Browser test calls over SIP: the page dials OpenAI's SIP endpoint through Telnyx WebRTC. */
export interface BrowserSipDeps {
  calls: BrowserSipCalls;
  /** Telnyx credential connection the page logs in to; it parks calls and sends webhooks to /telnyx/webhook */
  connectionId: string;
  projectId: string;
  region: () => "global" | "eu";
  /** short-lived Telnyx WebRTC login token for the test credential */
  loginToken: () => Promise<string>;
}

export interface TestCallDeps {
  manager: CallManager;
  browserCalls: BrowserCalls;
  upgradeWebSocket: UpgradeWebSocket;
  /** override CLOSE_GRACE_MS (tests) */
  testCallCloseGraceMs?: number;
  /** absent when OpenAI SIP or the Telnyx test credential isn't configured */
  browserSip?: BrowserSipDeps;
}

type ClientMsg = { type: "start"; dryRun?: boolean; protocol?: number } | { type: "hangup" } | { type: "underrun" };
/** at most one playback-underrun note per this many ms */
const UNDERRUN_NOTE_MS = 5000;

export function testCallRoutes(d: TestCallDeps) {
  const app = new Hono();

  // SIP test call: hand the page a Telnyx login token, the SIP URI and a nonce to send in
  // TEST_HEADER; the page then polls for the call id the webhook assigned.
  app.post("/test-call/sip", async (c) => {
    const sip = d.browserSip;
    if (!sip) {
      return c.json({ error: "SIP test calls need OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET and TELNYX_SIP_CREDENTIAL_ID" }, 404);
    }
    const body = await c.req.json<{ dryRun?: boolean }>().catch(() => ({}) as { dryRun?: boolean });
    try {
      const token = await sip.loginToken();
      const nonce = sip.calls.create(body.dryRun !== false);
      return c.json({ token, nonce, header: TEST_HEADER, dial: testDial(nonce), sipUri: sipUri(sip.projectId, sip.region()) });
    } catch (err) {
      return c.json({ error: `could not get a Telnyx login token: ${errMsg(err)}` }, 502);
    }
  });

  app.get("/test-call/sip/:nonce", (c) => c.json({ callId: d.browserSip?.calls.callId(c.req.param("nonce")) ?? null }));

  // The page's WebRTC audio is connected: Live may say the greeting now (openai-sip.ts).
  app.post("/test-call/sip/:nonce/connected", (c) =>
    d.browserSip?.calls.markConnected(c.req.param("nonce")) ? c.json({ ok: true }) : c.json({ error: "unknown or expired nonce" }, 404),
  );

  app.get(
    "/test-call/ws",
    d.upgradeWebSocket(() => {
      const callId = crypto.randomUUID();
      const ccid = `${PREFIX}${callId}`;
      let session: CallSession | undefined;
      let started = false;
      // Browser calls have no carrier recording: record mic (left) and what Live sent (right).
      const recorder = new StereoRecorder(16000, Date.now());
      let unsubscribe: (() => void) | undefined;
      let underruns = 0;
      let underrunNotedAt = 0;

      const start = async (ws: WSContext, dryRun: boolean) => {
        started = true;
        // Subscribe first so the browser also gets call.started.
        unsubscribe = d.manager.bus.subscribe((ev) => {
          if (ev.callId === callId) ws.send(JSON.stringify({ type: "event", event: ev }));
        });
        const media = new BrowserMediaChannel(ws, d.testCallCloseGraceMs ?? CLOSE_GRACE_MS, recorder, () => {
          d.manager
            .saveRecording(callId, recorder.toWav(), "wav")
            .catch((err) => log.warn("recording not saved", { callId, err }));
        });
        d.browserCalls.register(ccid, () => media.close());
        await d.manager.registerIncoming({ callId, callControlId: ccid, from: "browser", to: "test call" });
        ws.send(JSON.stringify({ type: "started", callId }));
        session = await d.manager.attachMedia(callId, media, "l16", { dryRun });
      };

      return {
        onMessage(evt, ws) {
          if (typeof evt.data !== "string") {
            // Mic audio: raw PCM16LE (no JSON/base64 on the page leg, like the agent audio back).
            // The session exists (and buffers audio) before Live has connected.
            const s = session ?? (started ? d.manager.get(callId) : undefined);
            if (!s || !(evt.data instanceof ArrayBuffer)) return;
            const bytes = new Uint8Array(evt.data);
            recorder.addCaller(bytes, Date.now());
            s.onCallerAudio(b64encode(bytes));
            return;
          }
          let msg: ClientMsg;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return;
          }
          switch (msg.type) {
            case "start":
              if (started) return;
              if (msg.protocol !== TEST_CALL_PROTOCOL) {
                ws.send(JSON.stringify({ type: "error", message: "This page is out of date: reload it and try again." }));
                ws.close();
                return;
              }
              start(ws, msg.dryRun !== false).catch((err) => {
                log.error("could not start", { callId, err });
                ws.send(JSON.stringify({ type: "error", message: errMsg(err) }));
                ws.close();
              });
              break;
            case "hangup":
              void d.manager.get(callId)?.hangup("hung up in browser", "caller");
              break;
            case "underrun":
              // The page's player ran dry mid-speech (audio late): heard as crackle or a gap.
              underruns++;
              if (Date.now() - underrunNotedAt >= UNDERRUN_NOTE_MS) {
                underrunNotedAt = Date.now();
                void d.manager.note(callId, "warn", `browser playback ran dry (audio arrived late): ${underruns} so far`);
              }
              break;
          }
        },
        onClose() {
          unsubscribe?.();
          d.browserCalls.unregister(ccid);
          if (started) void d.manager.hangup(callId, "browser disconnected", "caller");
        },
      };
    }),
  );

  return app;
}
