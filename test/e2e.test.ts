import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../src/adapters/storage/fs-blob";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { TelnyxApi } from "../src/adapters/telnyx/api";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import { b64decode, b64encode } from "../src/core/audio";
import { CallManager } from "../src/core/call-manager";
import { ConfigStore } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import { OwnerDesk } from "../src/core/owner-desk";
import { attachPersistence } from "../src/core/persist";
import type { Agent, VoiceAgent, VoiceSessionHandlers } from "../src/core/ports";
import { clientAssets } from "../src/runtime/client-assets";
import { createApp } from "../src/web/app";
import { TEST_CALL_PROTOCOL } from "../src/web/test-call-protocol";
import { BrowserCalls, routeTelephony } from "../src/web/test-call";
import { loadRepoConfig, scripted } from "./helpers";

// Steel thread with fake vendors: signed webhook → answer → media WS ↔ voice session →
// Jev tick → tell_live appended → the owner steers from Telegram → hangup → summary on the
// owner's status message → recording → UI.

const dataDir = mkdtempSync(join(tmpdir(), "scamsitter-"));
const telnyxRequests: { url: string; body: any }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("https://recordings.example")) return new Response(new Uint8Array([1, 2, 3]));
  telnyxRequests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.includes("v3%3Anostream/actions/streaming_start")) {
    return Response.json({ errors: [{ code: "90034", title: "Stream could not be started" }] }, { status: 500 });
  }
  if (url.includes("v3%3Agone/actions/answer")) {
    return Response.json(
      { errors: [{ code: "90018", title: "Call has already ended", detail: "This call is no longer active" }] },
      { status: 422 },
    );
  }
  return Response.json({ data: {} });
}) as typeof fetch;

const voice = {
  handlers: null as VoiceSessionHandlers | null,
  audioIn: [] as string[],
  appended: [] as string[],
  closed: false,
};
const fakeVoice: VoiceAgent = {
  async connect(_opts, h) {
    voice.handlers = h;
    return {
      sendAudio: (b64) => void voice.audioIn.push(b64),
      append: (_as, t) => void voice.appended.push(t),
      close: async () => void (voice.closed = true),
    };
  },
};
const fakeAgent: Agent = {
  run: async () => ({ toolCalls: [] }),
  summarize: async () => ({ text: "Bank impersonation scam; kept them busy." }),
};

let server: ReturnType<typeof Bun.serve>;
let sign: (msg: string) => Promise<string>;
let repo: SqliteRepo;
let manager: CallManager;
let config: ConfigStore;
let desk: OwnerDesk;
/** the owner's chat (Telegram) */
const owner = { sent: [] as { id: number; text: string }[], edits: [] as { id: number; text: string }[] };
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const pub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  sign = async (msg) =>
    b64encode(new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg))));

  const cfg = await loadRepoConfig();
  cfg.flow.timing.classify.settle_ms = 100;
  cfg.luna.summarize_on_hangup = true;
  cfg.connection.media_stream.noise_suppression.enabled = true;
  cfg.telegram.status.min_edit_interval_ms = 0;
  config = new ConfigStore(cfg);
  repo = new SqliteRepo(openSqlite(":memory:"));
  const blobs = new FsBlobStore(dataDir);
  const bus = new MemoryEventBus();
  attachPersistence(bus, repo);
  const telnyx = new TelnyxApi({ apiKey: "k", fetch: fakeFetch });
  const browserCalls = new BrowserCalls();
  desk = new OwnerDesk({
    bus,
    chat: {
      send: async (text) => (owner.sent.push({ id: owner.sent.length + 1, text }), owner.sent.length),
      edit: async (id, text) => void owner.edits.push({ id, text }),
      answerButton: async () => {},
    },
    config: () => config.get(),
    clock: { now: () => Date.now() },
    canSteer: true,
    steer: (id, text, as) => manager.get(id)?.steerFromOwner(text, as) ?? { ok: false, reason: "not connected" },
  });
  manager = new CallManager({
    config: () => config.get(),
    voice: fakeVoice,
    ownerStatus: () => desk.showsStatus,
    classifier: scripted({ verdict: "scam", confidence: 0.9 }),
    agent: fakeAgent,
    bus,
    telephony: routeTelephony(telnyx, browserCalls),
    clock: { now: () => Date.now() },
    repo,
    blobs,
  });
  const app = createApp({
    browserCalls,
    testCallCloseGraceMs: 300,
    verifier: new TelnyxVerifier(pub),
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
    clientAssets: await clientAssets({ rebuild: false }),
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
});

afterAll(() => {
  desk?.detach();
  server?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

async function webhook(event_type: string, payload: Record<string, unknown>, opts: { badSig?: boolean; id?: string } = {}) {
  const body = JSON.stringify({ data: { event_type, id: opts.id ?? crypto.randomUUID(), payload } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await sign(opts.badSig ? `${ts}|{}` : `${ts}|${body}`);
  return fetch(`${base()}/telnyx/webhook`, {
    method: "POST",
    headers: { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts, "content-type": "application/json" },
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

describe("steel thread (fake vendors)", () => {
  const ccid = "v3:test-call";
  let callId = "";

  test("rejects unsigned webhooks", async () => {
    const res = await webhook("call.initiated", {}, { badSig: true });
    expect(res.status).toBe(401);
  });

  test("call.initiated → call stored and answered with a bidirectional stream", async () => {
    const res = await webhook("call.initiated", {
      call_control_id: ccid,
      direction: "incoming",
      from: "+447911123456",
      to: "+447700900999",
      sip_headers: [{ name: "Diversion", value: "<sip:+447700900111@x>;reason=no-answer" }],
    });
    expect(res.status).toBe(200);
    await until(() => telnyxRequests.some((r) => r.url.endsWith("/actions/answer")));
    const answer = telnyxRequests.find((r) => r.url.endsWith("/actions/answer"))!;
    // Repo config uses PCMA (UK PSTN is A-law).
    expect(answer.body).toMatchObject({ stream_bidirectional_mode: "rtp", stream_bidirectional_codec: "PCMA" });
    expect(answer.body.stream_url).toMatch(/\/media\/[0-9a-f-]+\/pcma\/[\w-]+$/);
    const call = await repo.findByCallControlId(ccid);
    expect(call?.divertedFrom).toBe("+447700900111");
    callId = call!.id;
    await until(async () => (await repo.listEvents(callId)).some((e) => e.event.type === "sip.headers"));
    const sip = (await repo.listEvents(callId)).find((e) => e.event.type === "sip.headers")!.event;
    expect(sip).toMatchObject({ source: "telnyx", headers: [{ name: "Diversion", value: "<sip:+447700900111@x>;reason=no-answer" }] });
  });

  test("call.answered → noise suppression and dual-channel recording started", async () => {
    await webhook("call.answered", { call_control_id: ccid, client_state: btoa(JSON.stringify({ callId })) });
    await until(() => telnyxRequests.some((r) => r.url.endsWith("/actions/record_start")));
    expect(telnyxRequests.find((r) => r.url.endsWith("/actions/suppression_start"))!.body).toMatchObject({
      direction: "outbound",
      noise_suppression_engine: "Denoiser",
    });
    expect(telnyxRequests.find((r) => r.url.endsWith("/actions/record_start"))!.body).toMatchObject({
      channels: "dual",
      format: "mp3",
    });
  });

  test("media WS with a bad token is refused", async () => {
    const res = await fetch(`${base()}/media/${callId}/pcma/nope`);
    expect(res.status).toBe(403);
  });

  test("media relay, transcript, Jev tick → tell_live appended", async () => {
    const answer = telnyxRequests.find((r) => r.url.endsWith("/actions/answer"))!;
    const path = new URL(answer.body.stream_url.replace(/^ws/, "http")).pathname;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
    const fromServer: any[] = [];
    ws.onmessage = (m) => fromServer.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));
    await until(() => voice.handlers !== null);

    // Caller audio → voice session (PCMA passthrough).
    const frame = b64encode(new Uint8Array(160).fill(0xd5));
    ws.send(JSON.stringify({ event: "media", stream_id: "s", media: { track: "inbound", payload: frame } }));
    await until(() => voice.audioIn.includes(frame)); // passed through (the stall guard may add silence around it)

    // Agent audio → Telnyx media message.
    voice.handlers!.onAudio(b64encode(new Uint8Array(320).fill(0x7f)));
    await until(() => fromServer.some((m) => m.event === "media"));

    // Caller transcript → Jev tick → tell_live appended to the voice session.
    voice.handlers!.onTranscriptDelta("caller", "c1", "Hello, this is your bank's fraud team, ");
    voice.handlers!.onTranscriptDelta("caller", "c1", "we need to move your money to a safe account.");
    voice.handlers!.onTranscriptDone("caller", "c1");
    await until(() => voice.appended.length > 0);
    expect(voice.appended[0]).toContain("This is a scam or spam call.");

    // The owner replies to the call's status message on Telegram → Live.
    expect(owner.sent[0]!.text).toContain("+447911123456");
    await desk.onMessage({ messageId: 99, text: "~ask which branch they're calling from", replyTo: owner.sent[0]!.id, date: Date.now() });
    expect(voice.appended).toContain("SUPERVISOR: ask which branch they're calling from");

    ws.close();
  });

  test("call.hangup → call ended, summary stored", async () => {
    await webhook("call.hangup", { call_control_id: ccid, client_state: btoa(JSON.stringify({ callId })), hangup_cause: "normal_clearing", hangup_source: "caller" });
    await until(async () => (await repo.getCall(callId))?.summary != null);
    const call = (await repo.getCall(callId))!;
    expect(call.status).toBe("ended");
    expect(call.stage).toBe("waste_time");
    expect(call.verdict).toBe("scam");
    expect(call.endReason).toMatch(/hangup: normal_clearing|media stream closed/);
    expect(voice.closed).toBe(true);
    const types = (await repo.listEvents(callId)).map((e) => e.event.type);
    expect(types).toContain("transcript");
    expect(types).toContain("classification");
    expect(types).toContain("stage");
    expect(types).toContain("call.ended");
    // The owner's status message ends with the summary and keeps the steering.
    await until(() => owner.edits.at(-1)?.text.includes("Bank impersonation scam") ?? false);
    expect(owner.edits.at(-1)!.text).toContain("thinking: ask which branch they're calling from");
    expect(owner.edits.at(-1)!.text).toMatch(/💰 \$[0-9.]+ \(Live \$[0-9.]+ · Luna \$0\.000 · Jev/);
    // Stored broken down by vendor.
    const stored = (await repo.getCall(callId))!;
    expect(stored.costs).toMatchObject({ lunaUsd: 0, luna: { calls: 0, inputTokens: 0 }, jevInputTokens: 0 });
    expect(stored.costs!.liveUsd).toBeGreaterThan(0);
    expect(stored.costUsd).toBe(stored.costs!.totalUsd);
    const appends = (await repo.listEvents(callId)).map((e) => e.event).filter((e) => e.type === "live.append");
    expect(appends).toContainEqual(expect.objectContaining({ source: "owner", as: "thinking" }));
  });

  test("call.recording.saved → recording downloaded and linked", async () => {
    await webhook("call.recording.saved", {
      call_control_id: ccid,
      client_state: btoa(JSON.stringify({ callId })),
      recording_urls: { mp3: "https://recordings.example/r.mp3" },
    });
    await until(async () => (await repo.getCall(callId))?.recordingPath != null);
    const res = await fetch(`${base()}/recordings/${callId}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("admin UI shows the call; it is not served on the hooks host", async () => {
    const list = await (await fetch(`${base()}/`)).text();
    expect(list).toContain("+447911123456");
    const detail = await (await fetch(`${base()}/calls/${callId}`)).text();
    expect(detail).toContain("waste_time");
    expect(detail).toContain("Bank impersonation scam");
    const blocked = await fetch(`${base()}/`, { headers: { host: "hooks.example.com" } });
    expect(blocked.status).toBe(404);
  });
});

describe("telephony failures", () => {
  test("answer rejected by Telnyx → call ended with the Telnyx error, not left live", async () => {
    await webhook("call.initiated", { call_control_id: "v3:gone", direction: "incoming", from: "+447000000001", to: "+447000000002" });
    await until(async () => (await repo.findByCallControlId("v3:gone"))?.status === "ended");
    const call = (await repo.findByCallControlId("v3:gone"))!;
    expect(call.endReason).toBe("answer failed: Telnyx answer: 422 Call has already ended (90018)");
    const notes = (await repo.listEvents(call.id)).map((e) => e.event).filter((e) => e.type === "note");
    expect(notes.some((n) => n.type === "note" && n.level === "error" && n.message.includes("90018"))).toBe(true);
  });

  test("L16 answered but streaming_start failed → call hung up at the carrier too", async () => {
    config.get().connection.media_stream.codec = "l16";
    try {
      await webhook("call.initiated", { call_control_id: "v3:nostream", direction: "incoming", from: "+44", to: "+44" });
      await until(async () => (await repo.findByCallControlId("v3:nostream"))?.status === "ended");
    } finally {
      config.get().connection.media_stream.codec = "pcma";
    }
    expect(telnyxRequests.map((r) => r.url).filter((u) => u.includes("v3%3Anostream")).map((u) => u.split("/").pop())).toEqual([
      "answer",
      "streaming_start",
      "hangup",
    ]);
  });

  test("redelivered call.initiated doesn't create or answer a second call", async () => {
    const payload = { call_control_id: "v3:dup", direction: "incoming", from: "+44", to: "+44" };
    const id = crypto.randomUUID();
    await webhook("call.initiated", payload, { id });
    await webhook("call.initiated", payload, { id }); // same event id
    await webhook("call.initiated", payload); // same call, new event id
    await until(() => telnyxRequests.some((r) => r.url.includes("v3%3Adup/actions/answer")));
    await Bun.sleep(100);
    expect(telnyxRequests.filter((r) => r.url.includes("v3%3Adup/actions/answer"))).toHaveLength(1);
    expect((await repo.listCalls(100)).filter((c) => c.callControlId === "v3:dup")).toHaveLength(1);
  });

  test("draining → call.initiated rejected as busy, not stored or answered", async () => {
    manager.drain(60_000);
    try {
      await webhook("call.initiated", { call_control_id: "v3:drain", direction: "incoming", from: "+44", to: "+44" });
      await until(() => telnyxRequests.some((r) => r.url.includes("v3%3Adrain/actions/reject")));
    } finally {
      manager.resume();
    }
    expect(telnyxRequests.find((r) => r.url.includes("v3%3Adrain/actions/reject"))!.body).toMatchObject({ cause: "USER_BUSY" });
    expect(telnyxRequests.some((r) => r.url.includes("v3%3Adrain/actions/answer"))).toBe(false);
    expect(await repo.findByCallControlId("v3:drain")).toBeNull();
  });

  test("orphaned open calls (no session) are reaped and hung up", async () => {
    await manager.registerIncoming({ callId: "orphan", callControlId: "v3:orphan", from: "+44", to: "+44" });
    await manager.reapOrphans(60_000, "too young"); // just created: left alone
    expect((await repo.getCall("orphan"))?.status).toBe("ringing");
    await manager.reapOrphans(0, "server restarted");
    await until(async () => (await repo.getCall("orphan"))?.status === "ended");
    expect((await repo.getCall("orphan"))?.endReason).toBe("server restarted");
    expect(telnyxRequests.some((r) => r.url.includes("v3%3Aorphan/actions/hangup"))).toBe(true);
  });
});

describe("browser test call", () => {
  test("mic audio in, agent audio out, live events, hangup; Luna tools dry-run", async () => {
    voice.handlers = null;
    voice.audioIn = [];
    voice.appended = [];
    const page = await (await fetch(`${base()}/test-call`)).text();
    expect(page).toContain("/assets/test-call.js");
    expect((await fetch(`${base()}/assets/test-call-worklet.js`)).headers.get("content-type")).toContain("javascript");

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/test-call/ws`);
    ws.binaryType = "arraybuffer";
    const text: any[] = [];
    const binary: Uint8Array[] = [];
    let closed = false;
    ws.onmessage = (m) => (typeof m.data === "string" ? text.push(JSON.parse(m.data)) : binary.push(new Uint8Array(m.data)));
    ws.onclose = () => (closed = true);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "start", dryRun: true, protocol: TEST_CALL_PROTOCOL }));

    await until(() => text.some((m) => m.type === "started") && voice.handlers !== null);
    const callId = text.find((m) => m.type === "started").callId;
    const call = (await repo.getCall(callId))!;
    expect(call.callControlId).toBe(`browser:${callId}`);
    expect(text.some((m) => m.type === "event" && m.event.type === "call.started")).toBe(true);

    // Mic → voice session, passed through as-is (16 kHz PCM16).
    const mic = b64encode(new Uint8Array(640).fill(3));
    ws.send(b64decode(mic)); // binary PCM16LE
    await until(() => voice.audioIn.includes(mic));

    // Agent audio → binary frames to the page, passed through as-is.
    voice.handlers!.onAudio(b64encode(new Uint8Array(1280).fill(9)));
    await until(() => binary.reduce((n, b) => n + b.length, 0) >= 1280);
    expect(binary.every((b) => b.every((x) => x === 9))).toBe(true);

    // Transcript → live events on the same socket.
    voice.handlers!.onTranscriptDelta("caller", "b1", "Hi, this is your bank calling about a suspicious payment.");
    voice.handlers!.onTranscriptDone("caller", "b1");
    await until(() => text.some((m) => m.type === "event" && m.event.type === "classification"));

    ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => text.some((m) => m.type === "event" && m.event.type === "call.ended"));
    await until(() => closed); // closes after the grace period
    const ended = (await repo.getCall(callId))!;
    expect(ended.status).toBe("ended");
    expect(ended.endReason).toBe("hung up in browser");
    // Browser calls are recorded as a stereo WAV (mic left, Live's audio right).
    await until(async () => (await repo.getCall(callId))?.recordingPath != null);
    const rec = await (await fetch(`${base()}/recordings/${callId}`)).arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(rec, 0, 4))).toBe("RIFF");
    expect(new DataView(rec).getUint16(22, true)).toBe(2);
    // Hanging up a browser call must not touch Telnyx.
    expect(telnyxRequests.some((r) => r.url.includes(encodeURIComponent(`browser:${callId}`)))).toBe(false);
  });

  test("an out-of-date test-call page is told to reload instead of failing silently", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/test-call/ws`);
    const text: any[] = [];
    let closed = false;
    ws.onmessage = (m) => typeof m.data === "string" && text.push(JSON.parse(m.data));
    ws.onclose = () => (closed = true);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "start", dryRun: true })); // no protocol: a page from before binary audio
    await until(() => closed);
    expect(text).toEqual([{ type: "error", message: "This page is out of date: reload it and try again." }]);
  });
});
