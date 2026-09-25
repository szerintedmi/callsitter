import { Hono } from "hono";
import { NO_MEDIA, type CallManager } from "../core/call-manager";
import type { ConfigStore } from "../core/config";
import { errMsg } from "../core/orchestrator";
import type { Repo } from "../core/ports";
import { sipHeader, sipUser, type OpenAiSip, type SipHeader } from "../adapters/openai-live/sip";
import { divertedFrom } from "../adapters/telnyx/webhook";
import { RecentIds } from "./recent-ids";

// OpenAI SIP: the carrier sends the call to OpenAI, which posts `live.transport.incoming` here.
// We register the call, then CallManager starts an ordinary CallSession whose voice agent
// accepts the SIP session and attaches a sideband (adapters/openai-live/sip.ts). The call's
// audio never passes through us; the sideband reflects a copy for the recording.

/** Call-control ids of SIP calls: `sip:` + the Live session id. */
const PREFIX = "sip:";
export const sipCallControlId = (sessionId: string) => `${PREFIX}${sessionId}`;
export const isSipCall = (callControlId: string) => callControlId.startsWith(PREFIX);
export const sipSessionId = (callControlId: string) => callControlId.slice(PREFIX.length);

/** SIP header the browser SIP test sends with its nonce (headers are untrusted, so it can only make a call dry-run). */
export const TEST_HEADER = "X-ScamSitter-Test";

/**
 * What the browser SIP test dials: the WebRTC call parks at Telnyx (a WebRTC client can't dial
 * an external SIP URI: Telnyx answers 404 D11), our Telnyx webhook reads the nonce from the
 * dialled destination and transfers the call to OpenAI's SIP endpoint.
 */
export const TEST_DIAL_PREFIX = "scamsittertest";
export const testDial = (nonce: string) => `${TEST_DIAL_PREFIX}${nonce}`;
/** The nonce in a parked call's `to` (e.g. `scamsittertest<hex>` or `sip:scamsittertest<hex>@…`). */
export function nonceFromDialled(to: string | undefined): string | undefined {
  return to?.match(new RegExp(`${TEST_DIAL_PREFIX}([0-9a-f]{32})`))?.[1];
}

/**
 * Browser SIP test calls waiting for their webhook. The page gets a nonce from the UI, sends it
 * in TEST_HEADER, and polls for the call id. A matching call is labelled as a test call and gets
 * the dry-run setting chosen in the UI. The page also reports when its WebRTC audio is
 * connected, so the greeting isn't said before the browser can hear it.
 */
export class BrowserSipCalls {
  private pending = new Map<
    string,
    { dryRun: boolean; expires: number; callId?: string; connected: Promise<void>; markConnected: () => void }
  >();

  constructor(private ttlMs = 120_000) {}

  create(dryRun: boolean): string {
    this.sweep();
    // Hex only: it is also dialled as part of a destination (testDial).
    const nonce = crypto.randomUUID().replaceAll("-", "");
    let markConnected!: () => void;
    const connected = new Promise<void>((r) => (markConnected = r));
    this.pending.set(nonce, { dryRun, expires: Date.now() + this.ttlMs, connected, markConnected });
    return nonce;
  }

  /**
   * The pending test call for `nonce`, bound to `callId`; null if unknown, expired or already
   * used. `connected` resolves when the page reports its audio connected (markConnected).
   */
  claim(nonce: string | undefined, callId: string): { dryRun: boolean; connected: Promise<void> } | null {
    this.sweep();
    const p = nonce ? this.pending.get(nonce) : undefined;
    if (!p || p.callId) return null;
    p.callId = callId;
    return { dryRun: p.dryRun, connected: p.connected };
  }

  /** The page's WebRTC audio for `nonce` is connected; false if the nonce is unknown or expired. */
  markConnected(nonce: string): boolean {
    this.sweep();
    const p = this.pending.get(nonce);
    p?.markConnected();
    return !!p;
  }

  /** A live (unexpired) nonce, not yet bound to a call. */
  isPending(nonce: string | undefined): boolean {
    this.sweep();
    const p = nonce ? this.pending.get(nonce) : undefined;
    return !!p && !p.callId;
  }

  callId(nonce: string): string | null {
    return this.pending.get(nonce)?.callId ?? null;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
  }
}

export interface SipRoutesDeps {
  sip: OpenAiSip;
  manager: CallManager;
  repo: Repo;
  config: ConfigStore;
  browserSip: BrowserSipCalls;
}

export function openAiSipRoutes(d: SipRoutesDeps) {
  const app = new Hono();
  const seen = new RecentIds(1000);

  const incoming = async (sessionId: string, headers: SipHeader[], mediaSecurity?: string) => {
    const ccid = sipCallControlId(sessionId);
    // Redelivered after we handled it (webhook-id dedupe is per process).
    if (await d.repo.findByCallControlId(ccid)) return;
    const sc = d.config.get().connection.sip;
    if (!sc.enabled) {
      console.log(`[sip ${sessionId}] rejected (${sc.reject_status}): connection.sip.enabled is false`);
      await d.sip.reject(sessionId, sc.reject_status);
      return;
    }
    const callId = crypto.randomUUID();
    const test = d.browserSip.claim(sipHeader(headers, TEST_HEADER), callId);
    // Logged until the header mapping is confirmed on real calls (From/To/Diversion from Telnyx).
    console.log(`[sip ${sessionId}] incoming call ${callId} (${headers.length} SIP headers, media ${mediaSecurity ?? "unknown"})`);
    await d.manager.registerIncoming({
      callId,
      callControlId: ccid,
      from: test ? "browser (SIP)" : (sipUser(sipHeader(headers, "From")) ?? ""),
      to: test ? "test call" : (sipUser(sipHeader(headers, "To")) ?? ""),
      divertedFrom: test ? undefined : divertedFrom(headers),
    });
    await d.manager.sipHeaders(callId, "openai", headers, mediaSecurity);
    const record = sc.record;
    // OpenAI answers before the browser's WebRTC leg can play audio: hold the greeting until
    // the page says it's connected (or test_greeting_wait_ms), or "Hello?" goes unheard.
    const greetAfter = test
      ? Promise.race([test.connected, new Promise<void>((r) => setTimeout(r, sc.test_greeting_wait_ms))])
      : undefined;
    const voice = d.sip.voiceAgent(sessionId, {
      greetAfter,
      onRecording: record
        ? (wav) =>
            void d.manager
              .saveRecording(callId, wav, "wav")
              .catch((err) => console.warn(`[call ${callId}] recording not saved: ${errMsg(err)}`))
        : undefined,
    });
    try {
      // attachMedia accepts the call (voice.connect); on failure it hangs up and records why.
      await d.manager.attachMedia(callId, NO_MEDIA, "pcm24", { voice, mediaViaVoice: true, dryRun: test?.dryRun });
    } catch (err) {
      // If the accept itself failed the call is still ringing: reject it (fails harmlessly otherwise).
      await d.sip.reject(sessionId, 503).catch(() => undefined);
      throw err;
    }
  };

  app.post("/openai/webhook", async (c) => {
    const raw = await c.req.text();
    let ev;
    try {
      ev = await d.sip.unwrap(raw, c.req.raw.headers);
    } catch (err) {
      // Usually OPENAI_WEBHOOK_SECRET doesn't match the endpoint (e.g. after a secret rotation).
      console.warn(`[sip] webhook rejected: ${errMsg(err)}`);
      return c.text("invalid signature", 401);
    }
    const id = c.req.header("webhook-id") ?? ev.id;
    if (!seen.add(id)) return c.text("duplicate", 200);
    // live.call.incoming is the deprecated name; realtime.call.incoming is for the Realtime API.
    if (ev.type !== "live.transport.incoming") {
      console.log(`[sip] webhook ${ev.type} ignored`);
      return c.text("ignored", 200);
    }
    const { session_id, sip_headers, sip_media_security } = ev.data;
    // Acknowledge fast; accept in the background.
    incoming(session_id, sip_headers ?? [], sip_media_security).catch((err) => console.error(`[sip ${session_id}] ${errMsg(err)}`));
    return c.text("ok", 200);
  });

  return app;
}
