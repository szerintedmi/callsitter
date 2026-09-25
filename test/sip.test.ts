import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiSip, sipUser } from "../src/adapters/openai-live/sip";
import { FsBlobStore } from "../src/adapters/storage/fs-blob";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { TelnyxApi } from "../src/adapters/telnyx/api";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import { b64encode } from "../src/core/audio";
import { CallManager } from "../src/core/call-manager";
import { ConfigStore } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import { createApp } from "../src/web/app";
import { BrowserSipCalls, TEST_HEADER } from "../src/web/openai-sip";
import { BrowserCalls, routeTelephony } from "../src/web/test-call";
import { loadRepoConfig, scripted } from "./helpers";

// OpenAI SIP with a faked OpenAI: signed live.transport.incoming webhook → accept → sideband
// (transcripts in, steering out, reflected audio recorded) → session.closed → call ended.

const dataDir = mkdtempSync(join(tmpdir(), "scamsitter-sip-"));
const secretKey = crypto.getRandomValues(new Uint8Array(24));
const WEBHOOK_SECRET = `whsec_${b64encode(secretKey)}`;

/** OpenAI REST calls (accept/reject/hangup), by path. */
const rest: { path: string; body: any }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  rest.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.pathname.endsWith("/live_fails/accept")) return Response.json({ error: { message: "gone", type: "invalid_request_error" } }, { status: 404 });
  return new Response(null, { status: 200 });
}) as typeof fetch;

/** Sideband sockets the app opened, by session id, with what they sent. */
const sidebands = new Map<string, { ws: ServerWebSocket<{ id: string }>; sent: any[]; auth: string | null }>();
let liveServer: ReturnType<typeof Bun.serve<{ id: string; auth: string | null }>>;
let server: ReturnType<typeof Bun.serve>;
let repo: SqliteRepo;
let config: ConfigStore;
let browserSip: BrowserSipCalls;
/** Telnyx REST calls (token, transfer, hangup) */
const telnyxRest: { path: string; body: any }[] = [];
let telnyxSign: (msg: string) => Promise<string>;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  liveServer = Bun.serve<{ id: string; auth: string | null }>({
    port: 0,
    fetch(req, srv) {
      const m = new URL(req.url).pathname.match(/^\/([^/]+)\/attach$/);
      if (m && srv.upgrade(req, { data: { id: decodeURIComponent(m[1]!), auth: req.headers.get("authorization") } })) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sidebands.set(ws.data.id, { ws, sent: [], auth: ws.data.auth });
      },
      message(ws, m) {
        sidebands.get(ws.data.id)!.sent.push(JSON.parse(String(m)));
      },
    },
  });

  const cfg = await loadRepoConfig();
  cfg.flow.timing.classify.settle_ms = 100;
  cfg.luna.summarize_on_hangup = false;
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
      if (url.pathname.endsWith("/token")) return new Response("jwt-token\n");
      return Response.json({ data: {} });
    }) as unknown as typeof fetch,
  });
  const sip = new OpenAiSip({
    apiKey: "sk-test",
    webhookSecret: WEBHOOK_SECRET,
    fetch: fakeFetch,
    baseURL: "https://openai.test/v1",
    liveUrl: `ws://127.0.0.1:${liveServer.port}`,
  });
  const browserCalls = new BrowserCalls();
  browserSip = new BrowserSipCalls();
  const manager = new CallManager({
    config: () => config.get(),
    voice: { connect: () => Promise.reject(new Error("SIP calls must use the per-call agent")) },
    classifier: scripted({ verdict: "scam", confidence: 0.9 }),
    agent: { run: async () => ({ toolCalls: [] }), summarize: async () => "" },
    bus,
    notifier: telnyx,
    telephony: routeTelephony(telnyx, browserCalls, sip),
    clock: { now: () => Date.now() },
    ownerNumber: "",
    repo,
    blobs,
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
    uiAuth: { mode: "none" },
    mediaSecret: "s".repeat(32),
    upgradeWebSocket,
    clientAssets: async () => undefined,
    openAiSip: { sip },
    browserSip: { calls: browserSip, connectionId: "conn_test", projectId: "proj_test", region: () => "global", loginToken: () => telnyx.webrtcToken("cred") },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
});

afterAll(() => {
  server?.stop(true);
  liveServer?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function webhook(sessionId: string, sipHeaders: { name: string; value: string }[], opts: { badSig?: boolean; id?: string } = {}) {
  const body = JSON.stringify({
    id: "evt_1",
    object: "event",
    created_at: Math.floor(Date.now() / 1000),
    type: "live.transport.incoming",
    data: { session_id: sessionId, type: "sip", sip_headers: sipHeaders, sip_media_security: "srtp" },
  });
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = opts.badSig ? `${id}.${ts}.{}` : `${id}.${ts}.${body}`;
  const sig = b64encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))));
  return fetch(`${base()}/openai/webhook`, {
    method: "POST",
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}`, "content-type": "application/json" },
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

async function telnyxWebhook(event_type: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ data: { event_type, id: crypto.randomUUID(), payload } });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base()}/telnyx/webhook`, {
    method: "POST",
    headers: { "telnyx-signature-ed25519": await telnyxSign(`${ts}|${body}`), "telnyx-timestamp": ts, "content-type": "application/json" },
    body,
  });
}

const send = (id: string, ev: unknown) => sidebands.get(id)!.ws.send(JSON.stringify(ev));

describe("OpenAI SIP (fake OpenAI)", () => {
  const headers = [
    { name: "From", value: '"Caller" <sip:+447911123456@sip.telnyx.com>;tag=abc' },
    { name: "To", value: "<sip:proj_test@sip.api.openai.com>" },
    { name: "Diversion", value: "<sip:+447700900111@x>;reason=no-answer" },
  ];

  test("rejects unsigned webhooks", async () => {
    expect((await webhook("live_x", headers, { badSig: true })).status).toBe(401);
  });

  test("incoming → accepted with the Live config (no audio format), sideband attached, greeting sent", async () => {
    expect((await webhook("live_1", headers, { id: "msg_dup" })).status).toBe(200);
    expect(await (await webhook("live_1", headers, { id: "msg_dup" })).text()).toBe("duplicate");
    await until(() => sidebands.has("live_1"));
    const accept = rest.find((r) => r.path === "/v1/live/sessions/live_1/accept")!;
    const cfg = config.get().live;
    expect(accept.body.session).toMatchObject({ type: "live", model: cfg.model, audio: { output: { voice: cfg.voice } }, delegation: { type: "client" } });
    expect(accept.body.session.audio.format).toBeUndefined();
    expect(accept.body.session.instructions).toContain(cfg.instructions.trim().split("\n").at(-1));
    expect(accept.body.session.instructions).not.toContain("{current_time}"); // filled at call start
    expect(sidebands.get("live_1")!.auth).toBe("Bearer sk-test");
    await until(() => sidebands.get("live_1")!.sent.length > 0);
    expect(sidebands.get("live_1")!.sent[0]).toMatchObject({ type: "session.instructions.append", delegation_id: null });

    const call = (await repo.findByCallControlId("sip:live_1"))!;
    expect(call).toMatchObject({ from: "+447911123456", to: "proj_test", divertedFrom: "+447700900111", status: "active" });

    // Every header is kept for the call page's (collapsed) SIP headers section.
    const stored = (await repo.listEvents(call.id)).map((e) => e.event).find((e) => e.type === "sip.headers");
    expect(stored).toMatchObject({ source: "openai", mediaSecurity: "srtp", headers });
    expect(await (await fetch(`${base()}/ui/calls/${call.id}/sip-headers`)).json()).toMatchObject([{ source: "openai", headers }]);
    const page = await (await fetch(`${base()}/ui/calls/${call.id}`)).text();
    expect(page).toMatch(/<details class="debug"><summary>SIP headers \(3\)/);
    expect(page).toContain("reason=no-answer");
  });

  test("caller transcript over the sideband → Jev → tell_live appended over the sideband", async () => {
    send("live_1", { type: "session.input_transcript.delta", delta: "Hello, this is your bank's fraud team, ", start_ms: 0, end_ms: 500 });
    send("live_1", { type: "session.input_transcript.delta", delta: "move your money to a safe account.", start_ms: 500, end_ms: 1500 });
    await until(() => sidebands.get("live_1")!.sent.some((e) => String(e.content).includes("This is a scam or spam call.")), 5000);
  });

  test("reflected audio is recorded; session.closed ends the call and hangs up at OpenAI", async () => {
    // 100 ms of caller audio, then 100 ms of agent audio at 200 ms (24 kHz PCM16 = 4800 bytes/100 ms).
    send("live_1", { type: "session.input_audio.append", audio: b64encode(new Uint8Array(4800).fill(1)) });
    send("live_1", { type: "session.output_audio.delta", delta: b64encode(new Uint8Array(4800).fill(2)), start_ms: 200, end_ms: 300 });
    send("live_1", { type: "session.closed" });
    await until(async () => (await repo.findByCallControlId("sip:live_1"))?.recordingPath != null);
    const call = (await repo.findByCallControlId("sip:live_1"))!;
    expect(call.status).toBe("ended");
    expect(call.verdict).toBe("scam");
    expect(rest.some((r) => r.path === "/v1/live/sessions/live_1/hangup")).toBe(true);

    const wav = readFileSync(join(dataDir, call.recordingPath!));
    const v = new DataView(wav.buffer, wav.byteOffset);
    expect(v.getUint16(22, true)).toBe(2); // stereo
    expect(v.getUint32(24, true)).toBe(24000);
    const frames = v.getUint32(40, true) / 4;
    expect(frames).toBe(24000 * 0.3); // agent audio ends at 300 ms
    const sample = (i: number, ch: number) => v.getInt16(44 + i * 4 + ch * 2, true);
    expect(sample(10, 0)).toBe(0x0101); // caller, left
    expect(sample(24000 * 0.25, 1)).toBe(0x0202); // agent at 250 ms, right
    expect(sample(24000 * 0.1, 1)).toBe(0); // nothing before 200 ms
  });

  test("a failed accept rejects the call and ends it", async () => {
    await webhook("live_fails", headers);
    await until(() => rest.some((r) => r.path === "/v1/live/sessions/live_fails/reject"));
    await until(async () => (await repo.findByCallControlId("sip:live_fails"))?.status === "ended");
    expect(sidebands.has("live_fails")).toBe(false);
  });

  test("connection.sip.enabled: false → rejected with reject_status", async () => {
    config.get().connection.sip.enabled = false;
    try {
      await webhook("live_off", headers);
      await until(() => rest.some((r) => r.path === "/v1/live/sessions/live_off/reject"));
      expect(rest.find((r) => r.path === "/v1/live/sessions/live_off/reject")!.body).toEqual({ status_code: 480 });
      expect(await repo.findByCallControlId("sip:live_off")).toBeNull();
    } finally {
      config.get().connection.sip.enabled = true;
    }
  });

  test("browser SIP test: token + nonce from the UI, webhook with the nonce header → labelled dry-run test call", async () => {
    const res = await fetch(`${base()}/ui/test-call/sip`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base() },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { token: string; nonce: string; header: string; dial: string; sipUri: string };
    expect(j).toMatchObject({ token: "jwt-token", header: TEST_HEADER, sipUri: "sip:proj_test@sip.api.openai.com;transport=tls" });
    expect(j.dial).toBe(`scamsittertest${j.nonce}`);

    // The WebRTC call parks at Telnyx; our webhook transfers it to OpenAI over TLS + SRTP.
    await telnyxWebhook("call.initiated", {
      call_control_id: "v3:webrtc-leg",
      connection_id: "conn_test",
      direction: "incoming",
      state: "parked",
      from: "scamsittertest",
      to: `sip:${j.dial}@sip.telnyx.com`,
    });
    await until(() => telnyxRest.some((r) => r.path.endsWith("/actions/transfer")));
    const transfer = telnyxRest.find((r) => r.path.endsWith("/actions/transfer"))!;
    expect(transfer.path).toBe("/v2/calls/v3%3Awebrtc-leg/actions/transfer");
    expect(transfer.body).toMatchObject({
      to: "sip:proj_test@sip.api.openai.com",
      sip_transport_protocol: "TLS",
      media_encryption: "SRTP",
      custom_headers: [{ name: TEST_HEADER, value: j.nonce }],
    });
    // Test legs are never answered as phone calls (no media-stream answer).
    expect(telnyxRest.some((r) => r.path.endsWith("/actions/answer"))).toBe(false);
    expect(await repo.findByCallControlId("v3:webrtc-leg")).toBeNull();
    expect(await (await fetch(`${base()}/ui/test-call/sip/${j.nonce}`)).json()).toEqual({ callId: null });

    await webhook("live_browser", [...headers, { name: TEST_HEADER, value: j.nonce }]);
    await until(() => sidebands.has("live_browser"));
    const call = (await repo.findByCallControlId("sip:live_browser"))!;
    expect(call).toMatchObject({ from: "browser (SIP)", to: "test call", divertedFrom: null });
    expect(await (await fetch(`${base()}/ui/test-call/sip/${j.nonce}`)).json()).toEqual({ callId: call.id });

    // The greeting waits for the page to report its WebRTC audio connected.
    const greeted = () => sidebands.get("live_browser")!.sent.some((e) => String(e.content).includes("Speak first"));
    await Bun.sleep(200);
    expect(greeted()).toBe(false);
    const connected = await fetch(`${base()}/ui/test-call/sip/${j.nonce}/connected`, { method: "POST", headers: { origin: base() } });
    expect(connected.status).toBe(200);
    await until(greeted);
    expect((await fetch(`${base()}/ui/test-call/sip/${"0".repeat(32)}/connected`, { method: "POST" })).status).toBe(404);

    send("live_browser", { type: "session.closed" });
    await until(async () => (await repo.getCall(call.id))?.status === "ended");
  });

  test("browser SIP test: without the page's report, the greeting is sent after test_greeting_wait_ms", async () => {
    const sc = config.get().connection.sip;
    const wait = sc.test_greeting_wait_ms;
    sc.test_greeting_wait_ms = 300;
    try {
      const nonce = browserSip.create(true);
      const started = Date.now();
      await webhook("live_browser_nowait", [...headers, { name: TEST_HEADER, value: nonce }]);
      await until(() => sidebands.get("live_browser_nowait")?.sent.some((e) => String(e.content).includes("Speak first")) ?? false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      send("live_browser_nowait", { type: "session.closed" });
      await until(async () => (await repo.findByCallControlId("sip:live_browser_nowait"))?.status === "ended");
    } finally {
      sc.test_greeting_wait_ms = wait;
    }
  });
});

describe("browser SIP test legs", () => {
  test("a parked call with an unknown nonce is hung up, not transferred", async () => {
    const before = telnyxRest.filter((r) => r.path.endsWith("/actions/transfer")).length;
    await telnyxWebhook("call.initiated", {
      call_control_id: "v3:stranger",
      connection_id: "conn_test",
      direction: "incoming",
      state: "parked",
      to: `scamsittertest${"0".repeat(32)}`,
    });
    await until(() => telnyxRest.some((r) => r.path === "/v2/calls/v3%3Astranger/actions/hangup"));
    expect(telnyxRest.filter((r) => r.path.endsWith("/actions/transfer")).length).toBe(before);
  });
});

describe("sipUser", () => {
  test.each([
    ['"Bob" <sip:+447700900123@host>;tag=1', "+447700900123"],
    ["<sips:alice@example.com>", "alice"],
    ["tel:+14155550123", "+14155550123"],
    ["garbage", undefined],
  ])("%s → %s", (v, want) => expect(sipUser(v)).toBe(want));
});
