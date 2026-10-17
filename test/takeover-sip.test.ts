import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiSip } from "../src/adapters/openai-live/sip";
import { FsBlobStore } from "../src/adapters/storage/fs-blob";
import { FsRecordingStore } from "../src/adapters/storage/fs-recording";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { TelnyxApi } from "../src/adapters/telnyx/api";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import { decodeClientState } from "../src/adapters/telnyx/webhook";
import { b64decode, b64encode } from "../src/core/audio";
import { CallManager } from "../src/core/call-manager";
import { ConfigStore } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import type { OwnerAudioLeg, TakeoverState } from "../src/core/ports";
import { createApp } from "../src/web/app";
import { BrowserSipCalls } from "../src/web/openai-sip";
import { BrowserCalls, routeTelephony } from "../src/web/test-call";
import { loadRepoConfig, scripted } from "./helpers";

// Owner takeover over OpenAI SIP with faked OpenAI and Telnyx: takeOver → handover line → REFER
// → Telnyx offers the transferred leg (token in the dialled user) → answered with the takeover
// stream → caller ↔ owner audio → caller hangs up → one stitched recording.

const DOMAIN = "takeover.test";
const dataDir = mkdtempSync(join(tmpdir(), "callsitter-takeover-"));
const secretKey = crypto.getRandomValues(new Uint8Array(24));
const WEBHOOK_SECRET = `whsec_${b64encode(secretKey)}`;

const rest: { path: string; body: any }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  rest.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.pathname.endsWith("/live_nofer/refer")) return Response.json({ error: { message: "cannot refer", type: "invalid_request_error" } }, { status: 409 });
  return new Response(null, { status: 200 });
}) as typeof fetch;

const sidebands = new Map<string, { ws: ServerWebSocket<{ id: string }>; sent: any[] }>();
let liveServer: ReturnType<typeof Bun.serve<{ id: string }>>;
let server: ReturnType<typeof Bun.serve>;
let repo: SqliteRepo;
let config: ConfigStore;
let manager: CallManager;
const telnyxRest: { path: string; body: any }[] = [];
let telnyxSign: (msg: string) => Promise<string>;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  liveServer = Bun.serve<{ id: string }>({
    port: 0,
    fetch(req, srv) {
      const m = new URL(req.url).pathname.match(/^\/([^/]+)\/attach$/);
      if (m && srv.upgrade(req, { data: { id: decodeURIComponent(m[1]!) } })) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sidebands.set(ws.data.id, { ws, sent: [] });
      },
      message(ws, m) {
        sidebands.get(ws.data.id)!.sent.push(JSON.parse(String(m)));
      },
    },
  });

  const cfg = await loadRepoConfig();
  cfg.luna.summarize_on_hangup = false;
  cfg.luna.progress.enabled = false;
  cfg.telegram.takeover.max_handover_wait_ms = 0;
  config = new ConfigStore(cfg);
  repo = new SqliteRepo(openSqlite(":memory:"));
  const blobs = new FsBlobStore(dataDir);
  const bus = new MemoryEventBus();
  attachPersistence(bus, repo);
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const telnyxPub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  telnyxSign = async (msg) => b64encode(new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg))));
  const telnyx = new TelnyxApi({
    apiKey: "k",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      telnyxRest.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ data: {} });
    }) as unknown as typeof fetch,
  });
  const sip = new OpenAiSip({ apiKey: "sk-test", webhookSecret: WEBHOOK_SECRET, fetch: fakeFetch, baseURL: "https://openai.test/v1", liveUrl: `ws://127.0.0.1:${liveServer.port}` });
  const browserCalls = new BrowserCalls();
  manager = new CallManager({
    config: () => config.get(),
    voice: { connect: () => Promise.reject(new Error("SIP calls must use the per-call agent")) },
    classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
    agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
    bus,
    telephony: routeTelephony(telnyx, browserCalls, sip),
    clock: { now: () => Date.now() },
    repo,
    blobs,
    recordings: new FsRecordingStore(dataDir),
    takeoverSipDomain: DOMAIN,
  });
  const app = createApp({
    browserCalls,
    verifier: new TelnyxVerifier(telnyxPub),
    telnyx,
    manager,
    repo,
    blobs,
    bus,
    config,
    publicWsBase: "ws://127.0.0.1:0",
    adminAuth: { mode: "none" },
    mediaSecret: "s".repeat(32),
    upgradeWebSocket,
    clientAssets: async () => undefined,
    openAiSip: { sip },
    // "good" is the owner's fresh initData; anything else is stale
    takeover: { ownerUserId: 1, verifyInitData: async (s) => (s === "good" ? { userId: 1 } : null) },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
});

afterAll(() => {
  server?.stop(true);
  liveServer?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function sipWebhook(sessionId: string) {
  const body = JSON.stringify({
    id: `evt_${sessionId}`,
    object: "event",
    created_at: Math.floor(Date.now() / 1000),
    type: "live.transport.incoming",
    data: { session_id: sessionId, type: "sip", sip_headers: [{ name: "From", value: "<sip:07700900321@sip.telnyx.eu>" }, { name: "To", value: "<sip:proj_test@sip.api.openai.com>" }] },
  });
  const id = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`))));
  return fetch(`${base()}/openai/webhook`, {
    method: "POST",
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}`, "content-type": "application/json" },
    body,
  });
}

async function telnyxWebhook(event_type: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { event_type, id: crypto.randomUUID(), payload } });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base()}/telnyx/webhook`, {
    method: "POST",
    headers: { "telnyx-signature-ed25519": await telnyxSign(`${ts}|${body}`), "telnyx-timestamp": ts, "content-type": "application/json" },
    body,
  });
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

function fakeLeg() {
  const states: TakeoverState[] = [];
  const audio: Int16Array[] = [];
  let closed = false;
  const leg: OwnerAudioLeg = { sendAudio: (p) => void audio.push(p), notify: (s) => void states.push(s), close: () => void (closed = true) };
  return { leg, states, audio, closed: () => closed };
}

const actions = (ccid: string, action: string) => telnyxRest.filter((r) => r.path.endsWith(`/calls/${encodeURIComponent(ccid)}/actions/${action}`));

async function sipCall(sessionId: string) {
  await sipWebhook(sessionId);
  await until(() => sidebands.has(sessionId));
  await until(async () => (await repo.findByCallControlId(`sip:${sessionId}`))?.status === "active");
  return (await repo.findByCallControlId(`sip:${sessionId}`))!.id;
}

describe("owner takeover over OpenAI SIP (fake OpenAI and Telnyx)", () => {
  test("REFER → the transferred leg is answered (while draining) → audio both ways → caller hangs up → one recording", async () => {
    const callId = await sipCall("live_t1");
    expect(manager.canTakeOver(callId)).toBeNull();
    expect(manager.canTakeOver("nope")).toBe("that call has ended");
    // Caller audio over the sideband before the takeover: 100 ms.
    sidebands.get("live_t1")!.ws.send(JSON.stringify({ type: "session.input_audio.append", audio: b64encode(new Uint8Array(4800).fill(1)) }));

    const o = fakeLeg();
    const handle = await manager.takeOver(callId, o.leg);
    // Already the owner's: another page of theirs would replace this one.
    expect(manager.canTakeOver(callId)).toBeNull();
    await until(() => rest.some((r) => r.path === "/v1/live/sessions/live_t1/refer"));
    const target: string = rest.find((r) => r.path === "/v1/live/sessions/live_t1/refer")!.body.target_uri;
    const token = target.match(new RegExp(`^sip:cstakeover([0-9a-f]{32})@${DOMAIN.replace(".", "\\.")}$`))![1]!;
    expect(sidebands.get("live_t1")!.sent.some((e) => e.type === "session.commentary.append" && e.content === config.get().telegram.takeover.handover_text)).toBe(true);
    // OpenAI ends the session once Telnyx follows the REFER: the call goes on.
    sidebands.get("live_t1")!.ws.send(JSON.stringify({ type: "session.closed", reason: "remote_hangup" }));
    await Bun.sleep(50);
    expect((await repo.getCall(callId))!.status).toBe("active");

    // A deploy's drain doesn't turn the transferred leg away; a made-up token is refused.
    manager.drain(60_000);
    await telnyxWebhook("call.initiated", { call_control_id: "v3:bad", direction: "incoming", from: "+447700900321", to: `cstakeover${"0".repeat(32)}@${DOMAIN}` });
    await until(() => actions("v3:bad", "reject").length > 0);
    expect(actions("v3:bad", "reject")[0]!.body.cause).toBe("CALL_REJECTED");
    expect(await repo.findByCallControlId("v3:bad")).toBeNull();

    const offer = { call_control_id: "v3:leg", direction: "incoming", from: "+447700900321", to: `cstakeover${token}@${DOMAIN}` };
    await telnyxWebhook("call.initiated", offer);
    await until(() => actions("v3:leg", "answer").length > 0);
    const answer = actions("v3:leg", "answer")[0]!.body;
    expect(answer.stream_url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:0/media/takeover/${callId}/pcma/[\\w-]+$`));
    expect(answer.stream_codec).toBe("PCMA");
    expect(decodeClientState(answer.client_state)).toEqual({ callId, leg: "takeover" });
    expect((await repo.getCall(callId))!.callControlId).toBe("v3:leg");
    // Redelivered: not answered again.
    await telnyxWebhook("call.initiated", offer);
    await Bun.sleep(100);
    expect(actions("v3:leg", "answer").length).toBe(1);
    manager.resume();

    // Answered: no Telnyx recording (the sideband's goes on).
    await telnyxWebhook("call.answered", { call_control_id: "v3:leg", client_state: answer.client_state });
    await Bun.sleep(100);
    expect(actions("v3:leg", "record_start")).toEqual([]);

    // A wrong token can't open the stream.
    const bad = await fetch(`${base()}/media/takeover/${callId}/pcma/nope`);
    expect(bad.status).toBe(403);

    const ws = new WebSocket(answer.stream_url.replace("ws://127.0.0.1:0", `ws://127.0.0.1:${server.port}`));
    const fromUs: any[] = [];
    ws.onmessage = (m) => fromUs.push(JSON.parse(String(m.data)));
    await until(() => o.states.some((s) => s.type === "live"));
    ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: b64encode(new Uint8Array(160).fill(0xd5)) } }));
    await until(() => o.audio.length > 0);
    expect(o.audio[0]!.length).toBe(319);
    handle.ownerAudio(new Int16Array(320).fill(4000));
    await until(() => fromUs.some((m) => m.event === "media"));
    expect(b64decode(fromUs.find((m) => m.event === "media").media.payload).length).toBe(160);

    // The caller hangs up: the page hears it, and the recording covers both parts.
    await telnyxWebhook("call.hangup", { call_control_id: "v3:leg", client_state: answer.client_state, hangup_cause: "normal_clearing", hangup_source: "caller" });
    await until(async () => (await repo.getCall(callId))?.recordingPath != null);
    const call = (await repo.getCall(callId))!;
    expect(call).toMatchObject({ status: "ended", endedBy: "caller" });
    expect(o.states.at(-1)).toMatchObject({ type: "ended" });
    expect(o.closed()).toBe(true);
    const wav = readFileSync(join(dataDir, call.recordingPath!));
    const v = new DataView(wav.buffer, wav.byteOffset);
    expect(v.getUint32(24, true)).toBe(24000);
    const frames = v.getUint32(40, true) / 4;
    const sample = (i: number, ch: number) => v.getInt16(44 + i * 4 + ch * 2, true);
    expect(sample(10, 0)).toBe(0x0101); // the sideband's caller audio
    let owner = 0;
    for (let i = 0; i < frames; i++) owner = Math.max(owner, sample(i, 1));
    expect(owner).toBeGreaterThan(3000); // the owner, on the agent's track
    ws.close();
  });

  test("a failed REFER: the call stays with the agent", async () => {
    const callId = await sipCall("live_nofer");
    const o = fakeLeg();
    await manager.takeOver(callId, o.leg);
    await until(() => o.states.some((s) => s.type === "error"));
    expect(o.states.at(-1)!.type).toBe("error");
    expect(manager.canTakeOver(callId)).toBeNull();
    expect((await repo.getCall(callId))!.callControlId).toBe("sip:live_nofer");
    await manager.hangup(callId, "test over");
  });

  test("turned off in telegram.yaml: refused", async () => {
    const callId = await sipCall("live_off");
    config.get().telegram.takeover.enabled = false;
    try {
      expect(manager.canTakeOver(callId)).toBe("taking calls over is turned off (telegram.yaml takeover)");
      await expect(manager.takeOver(callId, fakeLeg().leg)).rejects.toThrow("turned off");
    } finally {
      config.get().telegram.takeover.enabled = true;
      await manager.hangup(callId, "test over");
    }
  });
});

/** The owner's page over the real /takeover/ws socket. */
async function page(callId: string, hello: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/takeover/ws/${callId}`);
  const json: any[] = [];
  let closed = false;
  ws.onmessage = (m) => typeof m.data === "string" && json.push(JSON.parse(m.data));
  ws.onclose = () => (closed = true);
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: "hello", ...hello }));
  return { ws, json, closed: () => closed, token: () => json.find((m) => m.type === "resume")?.token as string | undefined };
}

/** A SIP call taken over from the page, its transferred leg `ccid` connected. */
async function takenOver(sessionId: string, ccid: string) {
  const callId = await sipCall(sessionId);
  const p = await page(callId, { initData: "good" });
  await until(() => rest.some((r) => r.path === `/v1/live/sessions/${sessionId}/refer`));
  const token = rest.find((r) => r.path === `/v1/live/sessions/${sessionId}/refer`)!.body.target_uri.match(/cstakeover([0-9a-f]{32})@/)[1];
  await telnyxWebhook("call.initiated", { call_control_id: ccid, direction: "incoming", from: "+447700900321", to: `cstakeover${token}@${DOMAIN}` });
  await until(() => actions(ccid, "answer").length > 0);
  const media = new WebSocket(actions(ccid, "answer")[0]!.body.stream_url.replace("ws://127.0.0.1:0", `ws://127.0.0.1:${server.port}`));
  await until(() => p.json.some((m) => m.type === "live"));
  return { callId, p, media };
}

describe("the owner's page (real CallManager)", () => {
  test("Hang up on the page hangs up the transferred leg at Telnyx", async () => {
    const { callId, p, media } = await takenOver("live_h1", "v3:h1");
    p.ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => actions("v3:h1", "hangup").length > 0);
    await until(async () => (await repo.getCall(callId))?.status === "ended");
    expect((await repo.getCall(callId))!.endedBy).toBe("owner");
    await until(p.closed);
    media.close();
  });

  test("Hang up while still handing over hangs up the SIP call at OpenAI", async () => {
    const callId = await sipCall("live_h2");
    const p = await page(callId, { initData: "good" });
    await until(() => rest.some((r) => r.path === "/v1/live/sessions/live_h2/refer") && !!p.token());
    p.ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => rest.some((r) => r.path === "/v1/live/sessions/live_h2/hangup"));
    await until(async () => (await repo.getCall(callId))?.status === "ended");
  });

  test("a reconnect with the resume token works once initData is stale, and replaces a connection not yet known to be gone", async () => {
    config.get().telegram.takeover.reconnect_grace_ms = 100;
    try {
      const { callId, p, media } = await takenOver("live_r1", "v3:r1");
      await until(() => !!p.token());
      // Stale initData alone is refused.
      const stale = await page(callId, { initData: "stale" });
      await until(stale.closed);
      expect(stale.json[0].type).toBe("error");
      // With the token: the new page takes over; the old one is told and closed.
      const p2 = await page(callId, { initData: "stale", resume: p.token() });
      await until(() => p2.json.some((m) => m.type === "live") && !!p2.token());
      await until(p.closed);
      expect(p.json.some((m) => m.type === "error" && /newer connection/.test(m.message))).toBe(true);
      // The old socket's close didn't start the grace timer.
      await Bun.sleep(250);
      expect((await repo.getCall(callId))!.status).toBe("active");
      // Its token is spent.
      const reused = await page(callId, { initData: "stale", resume: p.token() });
      await until(reused.closed);
      expect((await repo.getCall(callId))!.status).toBe("active");
      // The new page leaving does hang up after the grace period.
      p2.ws.close();
      await until(async () => (await repo.getCall(callId))?.status === "ended");
      expect((await repo.getCall(callId))!.endedBy).toBe("owner");
      expect(actions("v3:r1", "hangup").length).toBeGreaterThan(0);
      media.close();
    } finally {
      config.get().telegram.takeover.reconnect_grace_ms = 10_000;
    }
  });
});
