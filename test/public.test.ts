import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiWebRtc } from "../src/adapters/openai-live/webrtc";
import { FsBlobStore } from "../src/adapters/storage/fs-blob";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { TelnyxApi } from "../src/adapters/telnyx/api";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import { CallManager } from "../src/core/call-manager";
import { ConfigStore, type AppConfig } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import { createApp } from "../src/web/app";
import { PublicGate, worstCaseUsd } from "../src/web/public";
import { BrowserCalls, routeTelephony } from "../src/web/test-call";
import { loadRepoConfig, scripted } from "./helpers";

// The public page with a faked OpenAI: SDP offer → POST /v1/live/sessions → answer back to the
// page, sideband attached, greeting once the page is connected, hangup closes the session.
// PublicGate's limits turn calls away.

const dataDir = mkdtempSync(join(tmpdir(), "scamsitter-public-"));
/** POST /v1/live/sessions bodies */
const created: any[] = [];
/** session ids hung up with POST /v1/live/sessions/:id/hangup */
const hungUp: string[] = [];
/** the fake refuses sideband attachments while set */
let refuseAttach = false;
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const hangup = url.pathname.match(/^\/v1\/live\/sessions\/([^/]+)\/hangup$/);
  if (hangup) {
    hungUp.push(decodeURIComponent(hangup[1]!));
    return new Response(null, { status: 200 });
  }
  if (url.pathname !== "/v1/live/sessions") return new Response(null, { status: 404 });
  created.push(JSON.parse(String(init?.body)));
  return Response.json({ session: { id: `live_w${created.length}` }, transport: { type: "webrtc", sdp: `v=0 answer ${created.length}` } });
}) as typeof fetch;

const sidebands = new Map<string, { ws: ServerWebSocket<{ id: string }>; sent: any[] }>();
let liveServer: ReturnType<typeof Bun.serve<{ id: string }>>;
let server: ReturnType<typeof Bun.serve>;
let repo: SqliteRepo;
let config: ConfigStore;
let defaults: AppConfig["public"];
let bus: MemoryEventBus;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  liveServer = Bun.serve<{ id: string }>({
    port: 0,
    fetch(req, srv) {
      const m = new URL(req.url).pathname.match(/^\/([^/]+)\/attach$/);
      if (m && !refuseAttach && srv.upgrade(req, { data: { id: decodeURIComponent(m[1]!) } })) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sidebands.set(ws.data.id, { ws, sent: [] });
      },
      message(ws, m) {
        const ev = JSON.parse(String(m));
        sidebands.get(ws.data.id)!.sent.push(ev);
        if (ev.type === "session.close") ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested" }));
      },
    },
  });

  const cfg = await loadRepoConfig();
  cfg.luna.summarize_on_hangup = false;
  cfg.public.greeting_wait_ms = 5000;
  defaults = { ...cfg.public };
  config = new ConfigStore(cfg);
  repo = new SqliteRepo(openSqlite(":memory:"));
  bus = new MemoryEventBus();
  attachPersistence(bus, repo);
  const telnyx = new TelnyxApi({ apiKey: "k", fetch: (async () => Response.json({ data: {} })) as unknown as typeof fetch });
  const browserCalls = new BrowserCalls();
  const manager = new CallManager({
    config: () => config.get(),
    voice: { connect: () => Promise.reject(new Error("public calls must use the per-call agent")) },
    classifier: scripted({ verdict: "scam", confidence: 0.9 }),
    agent: { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) },
    bus,
    telephony: routeTelephony(telnyx, browserCalls),
    clock: { now: () => Date.now() },
    repo,
    blobs: new FsBlobStore(dataDir),
  });
  const app = createApp({
    browserCalls,
    verifier: new TelnyxVerifier(btoa("x".repeat(32))),
    telnyx,
    manager,
    repo,
    blobs: new FsBlobStore(dataDir),
    bus,
    config,
    publicWsBase: "ws://127.0.0.1:0",
    adminAuth: { mode: "none", adminHost: "admin.test" },
    mediaSecret: "s".repeat(32),
    upgradeWebSocket,
    clientAssets: async (name) => (name === "public.js" ? "// page" : undefined),
    publicPage: {
      host: "127.0.0.1",
      config: () => config.get(),
      gate: new PublicGate({ repo, config: () => config.get(), clock: { now: () => Date.now() } }),
      webrtc: new OpenAiWebRtc({ apiKey: "sk-test", fetch: fakeFetch, baseURL: "https://openai.test/v1", liveUrl: `ws://127.0.0.1:${liveServer.port}` }),
    },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
});

afterAll(() => {
  server?.stop(true);
  liveServer?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  config.set({ ...config.get(), public: { ...defaults } });
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

let ipSeq = 0;
const call = (body: unknown = { sdp: "v=0 offer" }, headers: Record<string, string> = {}) =>
  fetch(`${base()}/call`, {
    method: "POST",
    headers: { origin: base(), "content-type": "application/json", "cf-connecting-ip": `10.0.0.${++ipSeq}`, ...headers },
    body: JSON.stringify(body),
  });
const post = (path: string) => fetch(`${base()}/${path}`, { method: "POST", headers: { origin: base() } });

async function hangUp(callId: string) {
  expect((await post(`call/${callId}/hangup`)).status).toBe(204);
  await until(async () => (await repo.getCall(callId))?.status === "ended");
}

describe("public page (fake OpenAI)", () => {
  test("serves the page and its script on the public host", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    expect(html).toContain(">Scam me<");
    expect(html).toContain(">or get through to me<");
    expect(html).toContain('src="/assets/public.js?v=');
    expect(html).not.toContain("<footer");
    expect(await (await fetch(`${base()}/assets/public.js`)).text()).toBe("// page");
    // Nothing of the admin UI.
    expect((await fetch(`${base()}/calls`)).status).toBe(404);
  });

  test("only this page may start or end calls", async () => {
    expect((await call(undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base()}/call`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await call({ sdp: "not an offer" })).status).toBe(400);
  });

  test("offer → answer, locked-down data channel, sideband, greeting on connect, hangup closes Live", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    const { callId, sdp } = (await r.json()) as { callId: string; sdp: string };
    expect(sdp).toMatch(/^v=0 answer/);
    const body = created.at(-1);
    expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0 offer" });
    expect(body.session).toMatchObject({
      model: config.get().live.model,
      delegation: { type: "client" },
      client: { data_channel: { allowed_client_events: [], allowed_server_events: [{ type: "session.closed" }] } },
    });
    const sessionId = `live_w${created.length}`;
    await until(() => sidebands.has(sessionId));
    expect(await repo.getCall(callId)).toMatchObject({ from: "public", callControlId: `web:${callId}`, status: "active", callerIp: `10.0.0.${ipSeq}` });

    // The greeting waits for the page's audio.
    await Bun.sleep(100);
    expect(sidebands.get(sessionId)!.sent).toEqual([]);
    expect((await post(`call/${callId}/connected`)).status).toBe(204);
    await until(() => sidebands.get(sessionId)!.sent.length > 0);
    expect(sidebands.get(sessionId)!.sent[0]).toMatchObject({ type: "session.instructions.append" });

    await hangUp(callId);
    // The call ends before the fake Live server has read the close frame.
    await until(() => sidebands.get(sessionId)!.sent.at(-1)?.type === "session.close");
    // The page's connection doesn't outlive the sideband.
    await until(() => hungUp.includes(sessionId));
  });

  test("no answer for the page if the sideband doesn't attach, and the session is hung up", async () => {
    refuseAttach = true;
    try {
      const r = await call();
      expect(r.status).toBe(502);
      expect(await r.json()).not.toHaveProperty("sdp");
      const sessionId = `live_w${created.length}`;
      await until(() => hungUp.includes(sessionId));
      expect(sidebands.has(sessionId)).toBe(false);
    } finally {
      refuseAttach = false;
    }
    // The slot is free again.
    const { callId } = (await (await call()).json()) as { callId: string };
    await hangUp(callId);
  });

  test("refuses oversized requests before reading them", async () => {
    const r = await call({ sdp: "v=0 offer", padding: "x".repeat(1024 * 1024) });
    expect(r.status).toBe(413);
  });

  test("streams Jev's verdict (hidden while unclear) and the stage to the page until the call ends", async () => {
    const { callId } = (await (await call()).json()) as { callId: string };
    const res = await fetch(`${base()}/call/${callId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    /** the next SSE message as [event, data] */
    const next = async (): Promise<[string, any]> => {
      while (!buf.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += value;
      }
      const [msg, ...rest] = buf.split("\n\n");
      buf = rest.join("\n\n");
      if (msg!.startsWith(":")) return next(); // keepalive
      const field = (k: string) => msg!.split("\n").find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
      return [field("event") ?? "message", JSON.parse(field("data")!)];
    };
    const classify = (choice: string, probabilities: Record<string, number>) =>
      bus.publish({
        type: "classification",
        callId,
        at: 0,
        classification: { verdict: choice as any, confidence: 0, urgency: 0, latencyMs: 1, answers: { verdict: { choice, probabilities } } },
      });
    expect(await next()).toEqual(["message", { verdict: null, lean: 0, stage: null }]);
    classify("scam", { scam: 0.5, spam: 0.3, genuine: 0.05, unclear: 0.15 });
    const [, scam] = await next();
    expect(scam).toMatchObject({ verdict: "scam", stage: null });
    expect(scam.lean).toBeCloseTo(0.75);
    bus.publish({ type: "stage", callId, at: 0, stage: "waste_time", as: "thinking" });
    expect((await next())[1]).toMatchObject({ verdict: "scam", stage: "waste time" });
    // Unclear: no verdict, and the needle falls back towards the middle.
    classify("unclear", { scam: 0.2, spam: 0, genuine: 0.3, unclear: 0.5 });
    const [, unclear] = await next();
    expect(unclear).toMatchObject({ verdict: null, stage: "waste time" });
    expect(unclear.lean).toBeCloseTo(-0.1);
    await hangUp(callId);
    expect((await next())[0]).toBe("ended");
    expect((await fetch(`${base()}/call/${callId}/events`)).status).toBe(404);
  });

  test("turns calls away: busy, per IP, over budget, closed", async () => {
    config.set({ ...config.get(), public: { ...defaults, max_concurrent: 1 } });
    const first = (await (await call()).json()) as { callId: string };
    const busy = await call();
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: "busy" });
    await hangUp(first.callId);
    // The slot is free again once the call has ended.
    const again = (await (await call()).json()) as { callId: string };
    await hangUp(again.callId);

    config.set({ ...config.get(), public: { ...defaults, per_ip_per_day: 1 } });
    const ok = (await (await call(undefined, { "cf-connecting-ip": "10.9.9.9" })).json()) as { callId: string };
    await hangUp(ok.callId);
    const limited = await call(undefined, { "cf-connecting-ip": "10.9.9.9" });
    expect(limited.status).toBe(429);
    // Concurrent requests can't all slip past the per-IP limit.
    const burst = await Promise.all([1, 2, 3].map(() => call(undefined, { "cf-connecting-ip": "10.9.9.8" })));
    expect(burst.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const [won] = await Promise.all(burst.map((r) => r.json() as Promise<{ callId?: string }>)).then((b) => b.filter((x) => x.callId));
    await hangUp(won!.callId!);

    config.set({ ...config.get(), public: { ...defaults, daily_usd: worstCaseUsd(config.get()) / 2 } });
    expect(await (await call()).json()).toMatchObject({ error: "budget" });

    config.set({ ...config.get(), public: { ...defaults, enabled: false } });
    expect(await (await call()).json()).toMatchObject({ error: "closed" });
  });

  test("public calls are capped at public.max_call_seconds", async () => {
    const cfg = config.get();
    // Below the schema's minimum, so the test runs quickly.
    config.set({ ...cfg, public: { ...defaults, max_call_seconds: 0.2 }, flow: { ...cfg.flow, timing: { ...cfg.flow.timing, time_up: undefined } } });
    const { callId } = (await (await call()).json()) as { callId: string };
    await until(async () => (await repo.getCall(callId))?.status === "ended");
    expect((await repo.getCall(callId))?.endReason).toBe("max call length reached");
    config.set(cfg);
  });
});
