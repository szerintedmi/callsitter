import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { isCodec, type Codec } from "../core/audio";
import type { CallManager } from "../core/call-manager";
import type { CallSession } from "../core/call-session";
import { logger } from "../core/log";
import { errMsg } from "../core/orchestrator";
import type { ConfigStore } from "../core/config";
import type { Repo } from "../core/ports";
import { TelnyxApiError, type TelnyxApi } from "../adapters/telnyx/api";
import { inboundToLive, parseInbound, TelnyxMediaChannel } from "../adapters/telnyx/media";
import type { TelnyxVerifier } from "../adapters/telnyx/signature";
import { decodeClientState, divertedFrom, encodeClientState, payloadInfo, type TelnyxWebhook } from "../adapters/telnyx/webhook";
import { mediaToken, verifyMediaToken } from "./media-token";
import { RecentIds } from "./recent-ids";
import { SIP_HOSTS } from "../adapters/openai-live/sip";
import { nonceFromDialled, TEST_HEADER } from "./openai-sip";
import type { BrowserSipDeps } from "./test-call";

export interface TelnyxRoutesDeps {
  verifier: TelnyxVerifier;
  telnyx: TelnyxApi;
  manager: CallManager;
  repo: Repo;
  config: ConfigStore;
  /** e.g. wss://hooks.example.com */
  publicWsBase: string;
  mediaSecret: string;
  upgradeWebSocket: UpgradeWebSocket;
  /** browser SIP test: parked WebRTC calls on its connection are transferred to OpenAI SIP */
  browserSip?: BrowserSipDeps;
}

// call.initiated and call.hangup fields left out of the call info: stored on the call already, or
// the same on every call.
const INITIATED_SKIP = ["call_control_id", "client_state", "connection_id", "connection_codecs", "from", "to", "direction", "state", "start_time", "occurred_at"];
const HANGUP_SKIP = ["call_control_id", "call_leg_id", "call_session_id", "client_state", "connection_id", "calling_party_type", "flow_destination", "from", "to", "start_time", "occurred_at"];

const describe = (err: unknown) => (err instanceof TelnyxApiError ? err.summary : errMsg(err));
const log = logger("telnyx");
const callLog = logger("call");
const mediaLog = logger("media");

/** Runs tasks one after another per key, so a call's webhooks are handled in order. */
class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  run(key: string, fn: () => Promise<void>, onError: (err: unknown) => Promise<void> | void) {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn).catch(onError).catch((err) => log.error("queued webhook failed", { key, err }));
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
  }
}

export function telnyxRoutes(d: TelnyxRoutesDeps) {
  const app = new Hono();
  const queue = new KeyedQueue();
  const seen = new RecentIds(1000);

  const resolveCallId = async (p: TelnyxWebhook["data"]["payload"]) => {
    const fromState = decodeClientState(p.client_state)?.callId;
    if (fromState) return fromState;
    if (!p.call_control_id) return null;
    return (await d.repo.findByCallControlId(p.call_control_id))?.id ?? null;
  };

  const handle = async (ev: TelnyxWebhook["data"]) => {
    const p = ev.payload;
    const ccid = p.call_control_id;
    // Browser SIP test legs live on their own credential connection: never answer them as phone calls.
    if (d.browserSip && p.connection_id === d.browserSip.connectionId) return handleTestLeg(ev);
    switch (ev.event_type) {
      case "call.initiated": {
        if (!ccid || p.direction !== "incoming") return;
        // Redelivered (or after a restart): the call exists already, so don't answer it again.
        // Webhooks for one call run in order, so this check can't race a first delivery.
        if (await d.repo.findByCallControlId(ccid)) return;
        // Draining for a deploy (or shutting down): the caller hears busy rather than being cut off later.
        if (!d.manager.accepting) {
          log.info("incoming call rejected: not accepting calls (draining)", { callControlId: ccid });
          await d.telnyx.reject(ccid, "USER_BUSY");
          return;
        }
        const callId = crypto.randomUUID();
        const codec = d.config.get().connection.media_stream.codec;
        const call = { callId, callControlId: ccid, from: p.from ?? "", to: p.to ?? "", divertedFrom: divertedFrom(p.sip_headers) };
        // Over a limit (limits.yaml phone): busy, before anything billed. If the reject fails, hang
        // up instead; if that fails too, the error propagates and no row is stored, since the
        // stored declined call makes a redelivery skip this and orphan cleanup ignore it.
        const hit = await d.manager.registerIncoming({ ...call, channel: "phone", caller: p.from });
        if (hit) {
          await d.telnyx.reject(ccid, "USER_BUSY").catch(async (err) => {
            callLog.warn("reject failed: hanging up instead", { callId, err: describe(err) });
            await d.telnyx.hangup(ccid);
          });
          await d.manager.declineIncoming({ ...call, channel: "phone", declined: hit, reason: await d.manager.declineReason("phone", hit) });
          return;
        }
        await d.manager.sipHeaders(callId, "telnyx", [...(p.sip_headers ?? []), ...(p.custom_headers ?? [])], { info: payloadInfo(p, INITIATED_SKIP) });
        const token = await mediaToken(d.mediaSecret, callId, codec);
        const streamUrl = `${d.publicWsBase}/media/${callId}/${codec}/${token}`;
        try {
          await d.telnyx.answer(ccid, streamUrl, codec, encodeClientState({ callId }));
        } catch (err) {
          // No media will ever connect and Telnyx may not send call.hangup, so end the call here.
          // For L16 the answer may have succeeded before streaming_start failed, leaving the
          // phone call up: hang it up at the carrier too (a 422 for an unanswered call is ignored).
          callLog.warn("answer failed", { callId, err: describe(err) });
          await d.manager.note(callId, "error", `answer failed: ${describe(err)}`);
          await d.telnyx
            .hangup(ccid)
            .catch((e) => callLog.warn("carrier hangup failed", { callId, err: describe(e) }));
          await d.manager.hangup(callId, `answer failed: ${describe(err)}`);
        }
        return;
      }
      case "call.answered": {
        const callId = await resolveCallId(p);
        if (!ccid || !callId) return;
        const ns = d.config.get().connection.media_stream.noise_suppression;
        if (ns.enabled) {
          // A failure here must not stop the recording; the call works without it.
          await d.telnyx
            .suppressionStart(ccid, { engine: ns.engine, direction: ns.direction })
            .catch((err) => callLog.warn("noise suppression not started", { callId, err }));
        }
        await d.telnyx.recordStart(ccid, encodeClientState({ callId }));
        return;
      }
      case "call.hangup": {
        const callId = await resolveCallId(p);
        if (!callId) return;
        // Usually after the media stream has closed and the call has ended here: kept anyway, as
        // it says who hung up and how the line was.
        await d.manager.carrierHangup(callId, payloadInfo(p, HANGUP_SKIP));
        await d.manager.hangup(callId, `hangup: ${p.hangup_cause ?? "unknown"} (${p.hangup_source ?? "?"})`, p.hangup_source === "caller" ? "caller" : "system");
        return;
      }
      case "call.cost": {
        const callId = await resolveCallId(p);
        if (!callId) return;
        // Number(null) is 0: a failed pricing must not pass for a free call.
        const usd = p.status === "success" && typeof p.total_cost === "string" ? Number(p.total_cost) : NaN;
        const currencies = [...new Set((p.cost_parts ?? []).map((c) => c.currency ?? "USD"))];
        if (!Number.isFinite(usd) || currencies.some((c) => c !== "USD")) {
          const why = p.status !== "success" ? `status ${p.status ?? "missing"}` : !Number.isFinite(usd) ? `total ${p.total_cost}` : `in ${currencies.join(", ")}`;
          await d.manager.note(callId, "warn", `carrier cost not added (${why})`);
          return;
        }
        await d.manager.carrierCost(callId, usd);
        return;
      }
      case "call.recording.saved": {
        const callId = await resolveCallId(p);
        const url = p.recording_urls?.mp3 ?? p.recording_urls?.wav;
        if (!callId || !url) return;
        // Pre-signed URL, valid for 10 minutes: download straight away.
        const data = await d.telnyx.download(url);
        await d.manager.saveRecording(callId, data, p.recording_urls?.mp3 ? "mp3" : "wav");
        return;
      }
    }
  };

  /**
   * The browser SIP test's WebRTC call parks at Telnyx; transfer it to OpenAI's SIP endpoint
   * (TLS + SRTP), carrying the page's nonce so /openai/webhook can match it. The transfer's
   * own leg (to OpenAI) and later events on this connection are only logged.
   */
  const handleTestLeg = async (ev: TelnyxWebhook["data"]) => {
    const sip = d.browserSip!;
    const p = ev.payload;
    const nonce = nonceFromDialled(p.to);
    const testLog = logger("sip test", { nonce: nonce?.slice(0, 8) });
    if (ev.event_type !== "call.initiated" || !nonce || !p.call_control_id) {
      const why = p.hangup_cause ? `: ${p.hangup_cause}${p.hangup_source ? ` (${p.hangup_source})` : ""}` : "";
      testLog.info(`Telnyx ${ev.event_type} ${p.direction ?? ""} ${p.from ?? ""} → ${p.to ?? ""}${why}`);
      return;
    }
    if (!sip.calls.isPending(nonce)) {
      testLog.warn("parked call with an unknown or expired nonce: hanging up");
      await d.telnyx.hangup(p.call_control_id);
      return;
    }
    // sip:<project>@host (no ;transport param): the transfer's sip_transport_protocol sets TLS.
    const to = `sip:${sip.projectId}@${SIP_HOSTS[sip.region()]}`;
    testLog.info(`parked WebRTC call from ${p.from ?? "?"}: transferring to ${to} (TLS, SRTP)`);
    try {
      await d.telnyx.transferToSip(p.call_control_id, { to, customHeaders: [{ name: TEST_HEADER, value: nonce }] });
    } catch (err) {
      testLog.error("transfer failed", { err: describe(err) });
      await d.telnyx.hangup(p.call_control_id).catch(() => undefined);
    }
  };

  app.post("/telnyx/webhook", async (c) => {
    const raw = await c.req.text();
    const ok = await d.verifier.verify(raw, c.req.header("telnyx-signature-ed25519") ?? null, c.req.header("telnyx-timestamp") ?? null);
    if (!ok) return c.text("invalid signature", 401);
    let body: TelnyxWebhook;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad json", 400);
    }
    const ev = body.data;
    if (!ev?.event_type) return c.text("ignored", 200);
    if (ev.id && !seen.add(ev.id)) return c.text("duplicate", 200);
    // Acknowledge fast; process in order per call. Errors are logged on one line and shown on the call.
    queue.run(
      ev.payload?.call_control_id ?? ev.id,
      () => handle(ev),
      async (err) => {
        const callId = ev.payload ? await resolveCallId(ev.payload).catch(() => null) : null;
        log.error(`${ev.event_type} failed`, { callId: callId ?? undefined, err: describe(err) });
        if (callId) await d.manager.note(callId, "error", `${ev.event_type}: ${describe(err)}`);
      },
    );
    return c.text("ok", 200);
  });

  app.get(
    "/media/:callId/:codec/:token",
    async (c, next) => {
      const { callId, codec, token } = c.req.param();
      if (!isCodec(codec) || !(await verifyMediaToken(d.mediaSecret, callId, codec, token))) {
        return c.text("forbidden", 403);
      }
      await next();
    },
    d.upgradeWebSocket((c) => {
      const callId = c.req.param("callId")!;
      const codec = c.req.param("codec") as Codec;
      let session: CallSession | undefined;
      let media: TelnyxMediaChannel | undefined;
      return {
        onOpen(_evt, ws) {
          media = new TelnyxMediaChannel(
            (msg) => ws.send(msg),
            () => ws.close(),
            codec,
          );
          d.manager
            .attachMedia(callId, media, codec)
            .then((s) => (session = s))
            .catch((err) => {
              mediaLog.error("could not start session", { callId, err });
              ws.close();
            });
        },
        onMessage(evt) {
          const msg = parseInbound(evt.data as string | ArrayBuffer);
          if (!msg) return;
          switch (msg.event) {
            case "media":
              if (msg.media.track === "inbound" || !msg.media.track) {
                // The session exists (and buffers audio) before Live has connected.
                (session ?? d.manager.get(callId))?.onCallerAudio(inboundToLive(msg.media.payload, codec));
              }
              break;
            case "start":
              mediaLog.info("stream started", { callId, format: msg.start.media_format ?? {} });
              break;
            case "error":
              mediaLog.error("Telnyx error", { callId, payload: msg.payload });
              break;
          }
        },
        onClose() {
          // If the call is still up, hang it up too (a 422 for an already-ended call is ignored).
          void d.manager.get(callId)?.hangup("media stream closed");
        },
      };
    }),
  );

  return app;
}
