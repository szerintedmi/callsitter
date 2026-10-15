import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiWebRtc } from "../src/adapters/openai-live/webrtc";
import { FsBlobStore } from "../src/adapters/storage/fs-blob";
import { notifySignups } from "../src/adapters/storage/schema";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { TelnyxApi } from "../src/adapters/telnyx/api";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import { CallManager } from "../src/core/call-manager";
import { ConfigStore, type AppConfig, type ChannelLimits } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import { CallGate } from "../src/core/limits";
import { attachPersistence } from "../src/core/persist";
import { createApp } from "../src/web/app";
import { BrowserCalls, routeTelephony } from "../src/web/test-call";
import { loadRepoConfig, scripted } from "./helpers";

// The public page with a faked OpenAI: SDP offer → POST /v1/live/sessions → answer back to the
// page, sideband attached, greeting once the page is connected, hangup closes the session.
// limits.yaml public turns calls away.

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
let db: ReturnType<typeof openSqlite>;
let repo: SqliteRepo;
let config: ConfigStore;
let defaults: AppConfig["public"];
let limitDefaults: ChannelLimits;
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
  limitDefaults = { ...cfg.limits.public };
  config = new ConfigStore(cfg);
  db = openSqlite(":memory:");
  repo = new SqliteRepo(db);
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
      webrtc: new OpenAiWebRtc({ apiKey: "sk-test", fetch: fakeFetch, baseURL: "https://openai.test/v1", liveUrl: `ws://127.0.0.1:${liveServer.port}` }),
      // Scam: the start once the caller says "police".
      // Get through: the message once they say they're late. Slow to judge once they say "slowly".
      referee: {
        judge: async (i): Promise<Record<string, number>> => {
          const said = (re: RegExp) => (i.transcript.some((e) => e.speaker === "caller" && re.test(e.text)) ? 0.9 : 0.1);
          if (said(/slowly/) > 0.5) await Bun.sleep(300);
          return i.game === "scam" ? { start: said(/police/i) } : { message: said(/late/) };
        },
      },
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
  config.set({ ...config.get(), public: { ...defaults }, limits: { ...config.get().limits, public: { ...limitDefaults } } });
});

/** limits.yaml public, over its defaults */
const limits = (l: Partial<ChannelLimits>) => config.set({ ...config.get(), limits: { ...config.get().limits, public: { ...limitDefaults, ...l } } });

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
let ipSeq = 0;
const GAME = { game: "scam", goal: "safe_account", player: "kev" };
const call = (body: unknown = { sdp: "v=0 offer", ...GAME }, headers: Record<string, string> = {}) =>
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
    expect(html).toContain(">SCAM ME<");
    expect(html).toContain(">GET THROUGH<");
    expect(html).toContain('src="/assets/public.js?v=');
    // The lobby the page starts from: every goal of games.yaml, with its leaderboard.
    const lobby = JSON.parse(html.match(/<script type="application\/json" id="lobby">(.*?)<\/script>/s)![1]!);
    expect(lobby.games.scam.map((g: { id: string }) => g.id)).toEqual(config.get().games.scam.goals.map((g) => g.id));
    expect(lobby.boards.get_through.plumber).toEqual(expect.any(Array));
    expect(await (await fetch(`${base()}/assets/public.js`)).text()).toBe("// page");
    // Nothing of the admin UI.
    expect((await fetch(`${base()}/calls`)).status).toBe(404);
  });

  test("shows no phone number", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    expect(html).not.toContain("tel:");
    expect(html).not.toContain('id="dial"');
  });

  test("only this page may start or end calls", async () => {
    expect((await call(undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base()}/call`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await call({ sdp: "not an offer", ...GAME })).status).toBe(400);
  });

  test("a call needs a known game and goal, and a player name", async () => {
    expect((await call({ sdp: "v=0 offer", ...GAME, game: "chess" })).status).toBe(400);
    expect((await call({ sdp: "v=0 offer", ...GAME, goal: "nope" })).status).toBe(400);
    expect(await (await call({ sdp: "v=0 offer", ...GAME, player: "toolong" })).json()).toMatchObject({ error: "name" });
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
    const r = await call({ sdp: "v=0 offer", ...GAME, padding: "x".repeat(1024 * 1024) });
    expect(r.status).toBe(413);
  });

  /** The call's server-sent events, as next() → [event, data]. */
  async function events(callId: string) {
    const res = await fetch(`${base()}/call/${callId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
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
    return next;
  }

  const classify = (callId: string, choice: string, probabilities: Record<string, number>) =>
    bus.publish({
      type: "classification",
      callId,
      at: 0,
      classification: { verdict: choice as any, confidence: 0, urgency: 0, latencyMs: 1, answers: { verdict: { choice, probabilities } } },
    });

  test("streams the game to the page (Jev's lean, the stage, when caught) until the call ends", async () => {
    const { callId } = (await (await call()).json()) as { callId: string };
    const next = await events(callId);
    expect(await next()).toEqual(["message", { verdict: null, lean: 0, stage: null, caughtAt: null, goalAt: null }]);
    classify(callId, "scam", { scam: 0.5, spam: 0.3, genuine: 0.05, unclear: 0.15 });
    const [, scam] = await next();
    expect(scam).toMatchObject({ verdict: "scam", stage: null, caughtAt: null });
    expect(scam.lean).toBeCloseTo(0.75);
    bus.publish({ type: "stage", callId, at: 4200, stage: "waste_time", as: "thinking" });
    expect((await next())[1]).toMatchObject({ verdict: "scam", stage: "waste_time", caughtAt: 4200 });
    // Unclear: no verdict, and the needle falls back towards the middle; still caught.
    classify(callId, "unclear", { scam: 0.2, spam: 0, genuine: 0.3, unclear: 0.5 });
    const [, unclear] = await next();
    expect(unclear).toMatchObject({ verdict: null, stage: "waste_time", caughtAt: 4200 });
    expect(unclear.lean).toBeCloseTo(-0.1);
    await hangUp(callId);
    expect((await next())[0]).toBe("ended");
    expect((await fetch(`${base()}/call/${callId}/events`)).status).toBe(404);
  });

  let seq = 0;
  const say = (callId: string, text: string, at: number) =>
    bus.publish({ type: "transcript", callId, entry: { seq: ++seq, speaker: "caller", text, at: at - 1000, endAt: at, final: true } });
  const resultOf = async (callId: string) => {
    let r: Response;
    await until(async () => (r = await fetch(`${base()}/call/${callId}/result`)).status === 200);
    return r!.json() as Promise<any>;
  };

  test("scam me: scored from the start (the referee) until the call ends; every score on the goal's leaderboard", async () => {
    // Times near the call's start, as its real length (a fraction of a second) sets the end.
    const play = async (player: string, start: boolean, caughtAt: number | null) => {
      const { callId } = (await (await call({ sdp: "v=0 offer", ...GAME, goal: "police", player })).json()) as { callId: string };
      expect((await fetch(`${base()}/call/${callId}/result`)).status).toBe(202);
      say(callId, "Hello, how are you?", 1000);
      classify(callId, "unclear", { unclear: 0.9 });
      await Bun.sleep(20);
      if (caughtAt !== null) bus.publish({ type: "stage", callId, at: caughtAt, stage: "waste_time", as: "thinking" });
      if (start) {
        say(callId, "This is the police, about your bank.", 1010); // the line starts at 10 ms
        classify(callId, "scam", { scam: 0.9 });
        await Bun.sleep(20);
      }
      await hangUp(callId);
      return resultOf(callId);
    };
    /** whole points (100 ms each) from the start at 10 ms until the call ended */
    const points = (r: { durationMs: number }) => Math.floor((r.durationMs - 10) / 100) * 100;
    // Never caught: all of it double. Caught before the start: all of it single.
    const ann = await play("ann", true, null);
    expect(ann).toMatchObject({ game: "scam", goal: "police", player: "ANN", scoreMs: 2 * points(ann) });
    const bob = await play("bob", true, 5);
    expect(bob).toMatchObject({ scoreMs: points(bob) });
    // Chatting, even for long after caught, without saying who they are: no score.
    expect(await play("cat", false, 5)).toMatchObject({ scoreMs: null, rank: null });
    expect(bob.board).toContainEqual({ player: "ANN", scoreMs: ann.scoreMs });
    expect(bob.rank).toBe(bob.board.findIndex((e: { scoreMs: number }) => e.scoreMs === bob.scoreMs) + 1);
    const lobby = (await (await fetch(`${base()}/call/lobby`)).json()) as any;
    expect(lobby.boards.scam.police).toEqual(bob.board);
    expect(lobby.undetectedMultiplier).toBe(2);
    expect((await fetch(`${base()}/call/nope/result`)).status).toBe(404);
  });

  test("get through: scored when the referee says the message was passed on, even in the last words", async () => {
    const { callId } = (await (await call({ sdp: "v=0 offer", game: "get_through", goal: "plumber", player: "liz" })).json()) as { callId: string };
    const next = await events(callId);
    await next();
    say(callId, "Hi, it's your plumber, I'm running 20 minutes late.", 12_000);
    classify(callId, "genuine", { genuine: 0.9 });
    await next(); // the classification
    expect((await next())[1]).toMatchObject({ goalAt: 12_000 });
    await hangUp(callId);
    expect(await resultOf(callId)).toMatchObject({ game: "get_through", goal: "plumber", player: "LIZ", scoreMs: 12_000, rank: 1 });

    // No Jev pause after it: the referee's last look at the end still counts it.
    const last = (await (await call({ sdp: "v=0 offer", game: "get_through", goal: "plumber", player: "max" })).json()) as { callId: string };
    say(last.callId, "Plumber here, running late, bye!", 9000);
    await hangUp(last.callId);
    expect(await resultOf(last.callId)).toMatchObject({ player: "MAX", scoreMs: 9000, rank: 1 });

    // The call has ended but the referee's last look is still going: not settled yet.
    const slow = (await (await call({ sdp: "v=0 offer", game: "get_through", goal: "plumber", player: "sue" })).json()) as { callId: string };
    say(slow.callId, "Plumber here, speaking slowly, running late.", 8000);
    await hangUp(slow.callId);
    expect((await fetch(`${base()}/call/${slow.callId}/result`)).status).toBe(202);
    expect(await resultOf(slow.callId)).toMatchObject({ player: "SUE", scoreMs: 8000 });
  });

  test("scammer time wasted counts ended calls judged scam or spam, public ones too, and every scam me game", async () => {
    const before = ((await (await fetch(`${base()}/call/lobby`)).json()) as any).wasted.seconds;
    const add = async (id: string, from: string, verdict: string, secs: number) => {
      await repo.createCall({ id, callControlId: id, from, to: "me", divertedFrom: null, channel: from === "public" ? "public" : "phone", startedAt: 1_000 });
      await repo.updateCall(id, { status: "ended", endedAt: 1_000 + secs * 1000, verdict });
    };
    await add("real-scam", "+447700900001", "scam", 90);
    await add("real-spam", "+447700900002", "spam", 30);
    await add("real-genuine", "+447700900003", "genuine", 45);
    await add("public-scam", "public", "scam", 600);
    // A scam me game Jev never caught counts too; a get through one doesn't.
    await add("game-scam", "public", "unclear", 40);
    await repo.createPlay({ callId: "game-scam", game: "scam", goal: "police", player: "ANN", createdAt: 1_000 });
    await add("game-through", "public", "unclear", 50);
    await repo.createPlay({ callId: "game-through", game: "get_through", goal: "plumber", player: "ANN", createdAt: 1_000 });
    expect(((await (await fetch(`${base()}/call/lobby`)).json()) as any).wasted).toEqual({ seconds: before + 760, live: 0 });
  });

  test("turns calls away: busy, per IP, over budget, closed", async () => {
    limits({ max_concurrent_calls: 1 });
    const first = (await (await call()).json()) as { callId: string };
    const busy = await call();
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: "busy" });
    await hangUp(first.callId);
    // The slot is free again once the call has ended.
    const again = (await (await call()).json()) as { callId: string };
    await hangUp(again.callId);

    limits({ max_calls_per_caller_per_day: 1 });
    const ok = (await (await call(undefined, { "cf-connecting-ip": "10.9.9.9" })).json()) as { callId: string };
    await hangUp(ok.callId);
    const limited = await call(undefined, { "cf-connecting-ip": "10.9.9.9" });
    expect(limited.status).toBe(429);
    // Concurrent requests can't all slip past the per-IP limit.
    const burst = await Promise.all([1, 2, 3].map(() => call(undefined, { "cf-connecting-ip": "10.9.9.8" })));
    expect(burst.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const [won] = await Promise.all(burst.map((r) => r.json() as Promise<{ callId?: string }>)).then((b) => b.filter((x) => x.callId));
    await hangUp(won!.callId!);
    // Counted from the call list: a restart doesn't reset it.
    const restarted = new CallGate({ repo, config: () => config.get(), clock: { now: () => Date.now() } });
    expect(await restarted.admit({ callId: "after-restart", channel: "public", caller: "10.9.9.9" })).toBe("per_caller");
    expect(await restarted.admit({ callId: "other-ip", channel: "public", caller: "10.9.9.7" })).toBeNull();

    // 0 is a cap of 0, not "off".
    limits({ max_spend_usd_per_day: 0 });
    expect(await (await call()).json()).toMatchObject({ error: "budget" });
    expect(((await (await fetch(`${base()}/call/lobby`)).json()) as any).out).toBe("budget");
    limits({});

    config.set({ ...config.get(), public: { ...defaults, enabled: false } });
    expect(await (await call()).json()).toMatchObject({ error: "closed" });
    expect(((await (await fetch(`${base()}/call/lobby`)).json()) as any).out).toBe("closed");
  });

  test("max_calls_per_day counts the day's public calls from the call list, so a restart doesn't reset it", async () => {
    const today = (await repo.listCallsByChannel("public", Date.now() - DAY_MS)).filter((r) => r.startedAt >= Date.now() - DAY_MS).length;
    limits({ max_calls_per_day: today + 1 });
    expect(((await (await fetch(`${base()}/call/lobby`)).json()) as any).out).toBeNull();
    const first = (await (await call()).json()) as { callId: string };
    await hangUp(first.callId);
    const refused = await call();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "quota" });
    const restarted = new CallGate({ repo, config: () => config.get(), clock: { now: () => Date.now() } });
    expect(await restarted.admit({ callId: "after-restart", channel: "public", caller: "10.8.8.8" })).toBe("quota");
    expect(await restarted.exhausted("public")).toBe("quota");
    expect(((await (await fetch(`${base()}/call/lobby`)).json()) as any).out).toBe("quota");
  });

  test("notify me: stores the email once, with where it came from and what had run out; signing up again refreshes it", async () => {
    limits({ max_calls_per_day: 0 });
    const notify = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base()}/call/notify`, {
        method: "POST",
        headers: { origin: base(), "content-type": "application/json", "cf-connecting-ip": "10.7.7.7", "user-agent": "phone", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const res = await notify({ email: "  Ann@Example.com " }, { "cf-ipcountry": "GB" });
    expect(res.status).toBe(204);
    expect(db.select().from(notifySignups).all()).toEqual([
      expect.objectContaining({ email: "ann@example.com", ip: "10.7.7.7", country: "GB", userAgent: "phone", reason: "quota", notifiedAt: null }),
    ]);
    // Signed up already, and mailed since: the same answer, still one row, with the new details and pending again.
    db.update(notifySignups).set({ notifiedAt: 1 }).run();
    limits({});
    expect((await notify({ email: "ann@example.com" }, { "cf-connecting-ip": "10.7.7.8", "user-agent": "laptop" })).status).toBe(204);
    expect(db.select().from(notifySignups).all()).toEqual([
      expect.objectContaining({ email: "ann@example.com", ip: "10.7.7.8", country: null, userAgent: "laptop", reason: null, notifiedAt: null }),
    ]);

    const bad = await notify({ email: "not an email" }, { "cf-connecting-ip": "10.7.7.6" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "email" });
    for (const body of ["null", "1", '"a@b.co"']) expect((await notify(body, { "cf-connecting-ip": "10.7.7.6" })).status).toBe(400);
    expect((await notify({ email: "a@b.co" }, { origin: "https://evil.test", "cf-connecting-ip": "10.7.7.6" })).status).toBe(403);
    expect((await notify(JSON.stringify({ email: `${"x".repeat(3000)}@b.co` }), { "cf-connecting-ip": "10.7.7.6" })).status).toBe(413);

    limits({});
    config.set({ ...config.get(), public: { ...defaults, notify_per_ip_per_day: 2 } });
    expect((await notify({ email: "b@example.com" }, { "cf-connecting-ip": "10.7.7.5" })).status).toBe(204);
    expect((await notify({ email: "c@example.com" }, { "cf-connecting-ip": "10.7.7.5" })).status).toBe(204);
    expect((await notify({ email: "d@example.com" }, { "cf-connecting-ip": "10.7.7.5" })).status).toBe(429);
    expect(db.select().from(notifySignups).all().map((r) => [r.email, r.reason])).toEqual([
      ["ann@example.com", null],
      ["b@example.com", null],
      ["c@example.com", null],
    ]);
  });

  test("the bot page: a waitlist form that posts to call/waitlist, under the page's own path", async () => {
    const res = await fetch(`${base()}/bot`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("GET YOUR OWN BOT");
    expect(html).toContain('id="wl-in" type="email"');
    expect(html).toContain('"/call/waitlist"');
    // without the script the form can't submit: a GET would put the email in the URL
    expect(html).toContain('<form class="wl" id="wl" method="post"');
    expect(html).toContain('id="wl-ok" disabled');
    expect(html).toContain('<a class="rc-brand" href="/"');
    expect(html).not.toContain("ScamSitter answers your phone");
    expect(html).not.toContain("tel:");
  });

  test("waitlist: stores the email once on its own list, refreshes it on a repeat, and the same email can be on both lists", async () => {
    db.delete(notifySignups).run();
    config.set({ ...config.get(), public: { ...defaults } });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base()}/call/${path}`, {
        method: "POST",
        headers: { origin: base(), "content-type": "application/json", "cf-connecting-ip": "10.6.6.6", "user-agent": "phone", ...headers },
        body: JSON.stringify(body),
      });
    expect((await post("waitlist", { email: " Bo@Example.com" }, { "cf-ipcountry": "HU" })).status).toBe(204);
    expect(db.select().from(notifySignups).all()).toEqual([
      expect.objectContaining({ email: "bo@example.com", list: "waitlist", ip: "10.6.6.6", country: "HU", userAgent: "phone", reason: null, notifiedAt: null }),
    ]);
    db.update(notifySignups).set({ notifiedAt: 1 }).run();
    expect((await post("waitlist", { email: "bo@example.com" }, { "cf-connecting-ip": "10.6.6.7", "user-agent": "laptop" })).status).toBe(204);
    expect(db.select().from(notifySignups).all()).toEqual([
      expect.objectContaining({ email: "bo@example.com", list: "waitlist", ip: "10.6.6.7", country: null, userAgent: "laptop", notifiedAt: null }),
    ]);
    // the same email on the "notify me" list too: a row of its own
    expect((await post("notify", { email: "bo@example.com" })).status).toBe(204);
    expect(db.select().from(notifySignups).all().map((r) => [r.email, r.list])).toEqual([
      ["bo@example.com", "waitlist"],
      ["bo@example.com", "notify"],
    ]);

    const bad = await post("waitlist", { email: "nope" }, { "cf-connecting-ip": "10.6.6.5" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "email" });
    expect((await post("waitlist", { email: "a@b.co" }, { origin: "https://evil.test" })).status).toBe(403);

    config.set({ ...config.get(), public: { ...defaults, notify_per_ip_per_day: 1 } });
    expect((await post("waitlist", { email: "c@example.com" }, { "cf-connecting-ip": "10.6.6.4" })).status).toBe(204);
    const limited = await post("waitlist", { email: "d@example.com" }, { "cf-connecting-ip": "10.6.6.4" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "limit" });
    expect(db.select().from(notifySignups).all().filter((r) => r.list === "waitlist").map((r) => r.email)).toEqual(["bo@example.com", "c@example.com"]);
    config.set({ ...config.get(), public: { ...defaults } });
  });

  test("public calls are capped at limits.yaml public.max_call_seconds", async () => {
    const cfg = config.get();
    // Below the schema's minimum, so the test runs quickly.
    config.set({
      ...cfg,
      limits: { ...cfg.limits, public: { ...limitDefaults, max_call_seconds: 0.2 } },
      flow: { ...cfg.flow, timing: { ...cfg.flow.timing, time_up: undefined } },
    });
    const { callId } = (await (await call()).json()) as { callId: string };
    await until(async () => (await repo.getCall(callId))?.status === "ended");
    expect((await repo.getCall(callId))?.endReason).toBe("max call length reached");
    config.set(cfg);
  });
});
