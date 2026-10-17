import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import { sign } from "hono/jwt";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import type { CallManager } from "../src/core/call-manager";
import { ConfigStore } from "../src/core/config";
import { MemoryEventBus } from "../src/core/event-bus";
import type { OwnerAudioLeg, TakeoverHandle } from "../src/core/ports";
import { buildClient } from "../src/runtime/client-assets";
import type { AdminAuth } from "../src/web/admin-guard";
import { createApp } from "../src/web/app";
import { BrowserCalls } from "../src/web/test-call";
import { loadRepoConfig } from "./helpers";

// The admin call page's takeover (/calls/<id>/takeover), through createApp so adminGuard is the
// real one: on loopback (ADMIN_AUTH=none) and behind Cloudflare Access with a test JWKS. And the
// security boundary: only the guarded admin mount takes a hello without Telegram initData.

const assets = await buildClient();
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-1";
const ADMIN = "admin.test";

/** The CallManager parts the takeover routes and the call page use. */
class FakeManager {
  off: string | null = null;
  takeOvers: string[] = [];
  resumes: string[] = [];
  takeoverOff = () => this.off;
  canTakeOver = (_id: string) => this.off;
  async takeOver(callId: string, leg: OwnerAudioLeg): Promise<TakeoverHandle> {
    this.takeOvers.push(callId);
    return this.attach(leg);
  }
  resumeTakeover(callId: string, token: string, leg: OwnerAudioLeg): TakeoverHandle {
    if (token !== `tok${this.takeOvers.length + this.resumes.length}`) throw new Error("that connection was replaced");
    this.resumes.push(callId);
    return this.attach(leg);
  }
  private attach(leg: OwnerAudioLeg): TakeoverHandle {
    leg.notify({ type: "connecting" });
    return { ownerAudio() {}, ownerLeft() {}, pageStats() {}, hangUp: () => leg.close(), reconnectToken: `tok${this.takeOvers.length + this.resumes.length}` };
  }
}

let manager: FakeManager;
const repo = new SqliteRepo(openSqlite(":memory:"));
const config = new ConfigStore(await loadRepoConfig());

function app(adminAuth: AdminAuth, jwks: object[] = []) {
  return createApp({
    browserCalls: new BrowserCalls(),
    verifier: new TelnyxVerifier(btoa("x".repeat(32))),
    telnyx: {} as never,
    manager: {
      takeoverOff: () => manager.takeoverOff(),
      canTakeOver: (id: string) => manager.canTakeOver(id),
      takeOver: (id: string, leg: OwnerAudioLeg) => manager.takeOver(id, leg),
      resumeTakeover: (id: string, t: string, leg: OwnerAudioLeg) => manager.resumeTakeover(id, t, leg),
    } as unknown as CallManager,
    repo,
    blobs: {} as never,
    bus: new MemoryEventBus(),
    config,
    publicWsBase: "ws://127.0.0.1:0",
    adminAuth,
    adminGuardDeps: { fetch: (async () => Response.json({ keys: jwks })) as unknown as typeof fetch },
    mediaSecret: "s".repeat(32),
    upgradeWebSocket,
    clientAssets: async (name) => assets.get(name),
    // The Telegram mount too: its hello needs initData ("good" is the owner's).
    takeover: { ownerUserId: 1, verifyInitData: async (s) => (s === "good" ? { userId: 1 } : null) },
  });
}

async function rsaKey(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    pub: { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid, alg: "RS256", use: "sig" },
    priv: { ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid, alg: "RS256" },
  };
}
const key = await rsaKey("k1");
const now = Math.floor(Date.now() / 1000);
const jwt = await sign({ iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", iat: now, exp: now + 600 }, key.priv, "RS256");

let local: ReturnType<typeof Bun.serve>; // ADMIN_AUTH=none: loopback is the admin host
let access: ReturnType<typeof Bun.serve>; // Access on admin.test: 127.0.0.1 is just any host
beforeAll(async () => {
  local = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app({ mode: "none" }).fetch, websocket });
  access = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app({ mode: "access", adminHost: ADMIN, teamDomain: TEAM, aud: AUD }, [key.pub]).fetch, websocket });
  await repo.createCall({ id: "c-live", callControlId: "cc-live", from: "+441234", to: "+449999", divertedFrom: null, channel: "phone", startedAt: Date.now() });
  await repo.updateCall("c-live", { status: "active" });
  await repo.createCall({ id: "c-test", callControlId: "browser:c-test", from: "", to: "", divertedFrom: null, channel: "test", startedAt: Date.now() });
  await repo.createCall({ id: "c-ended", callControlId: "cc-ended", from: "+441", to: "+449", divertedFrom: null, channel: "phone", startedAt: Date.now() });
  await repo.updateCall("c-ended", { status: "ended", endedAt: Date.now() });
  await repo.createCall({ id: "c-taken", callControlId: "cc-taken", from: "+442", to: "+449", divertedFrom: null, channel: "phone", startedAt: Date.now() });
  await repo.appendEvent({ type: "takeover.started", callId: "c-taken", at: 1 });
});
afterAll(() => {
  local?.stop(true);
  access?.stop(true);
});
beforeEach(() => (manager = new FakeManager()));

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

/** Opens a socket (Bun's WebSocket takes headers), sends `hello` and collects the JSON frames. */
async function open(url: string, hello: unknown, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as never);
  const json: any[] = [];
  let closed = false;
  let failed = false;
  ws.onmessage = (m) => typeof m.data === "string" && json.push(JSON.parse(m.data));
  ws.onclose = () => (closed = true);
  ws.onerror = () => (failed = true);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
    const t = setInterval(() => (failed || closed) && (clearInterval(t), r()), 5);
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  return { ws, json, closed: () => closed, opened: !failed && !closed };
}

describe("admin call page: Take over button", () => {
  const page = async (id: string) => (await fetch(`http://127.0.0.1:${local.port}/calls/${id}`)).text();

  test("on a live phone call with takeover set up, linking to the admin takeover page", async () => {
    const html = await page("c-live");
    expect(html).toMatch(/<button id="takeover"[^>]*data-href="\/calls\/c-live\/takeover"/);
    expect(html).not.toMatch(/<button id="takeover"[^>]*hidden/);
  });

  test("hidden while taken over; absent when takeover is off, the call ended or isn't a phone call", async () => {
    expect(await page("c-taken")).toMatch(/<button id="takeover"[^>]*hidden/);
    expect(await page("c-ended")).not.toContain('id="takeover"');
    expect(await page("c-test")).not.toContain('id="takeover"');
    manager.off = "taking calls over isn't set up (TELNYX_TAKEOVER_SIP_DOMAIN)";
    expect(await page("c-live")).not.toContain('id="takeover"');
  });
});

describe("admin takeover page and socket (ADMIN_AUTH=none, loopback)", () => {
  test("serves the page in admin mode, without Telegram's script; its scripts from the admin /assets/", async () => {
    const r = await fetch(`http://127.0.0.1:${local.port}/calls/c-live/takeover`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<body data-mode="admin">');
    expect(html).not.toContain("telegram.org");
    for (const name of ["takeover.js", "test-call-worklet.js"]) expect((await fetch(`http://127.0.0.1:${local.port}/assets/${name}`)).status).toBe(200);
  });

  test("a hello without initData takes the call over; a reconnect resumes with its token", async () => {
    const c = await open(`ws://127.0.0.1:${local.port}/calls/c-live/takeover/ws`, { type: "hello" });
    await until(() => c.json.some((m) => m.type === "resume"));
    expect(manager.takeOvers).toEqual(["c-live"]);
    expect(c.json).toEqual([{ type: "connecting" }, { type: "resume", token: "tok1" }]);
    const again = await open(`ws://127.0.0.1:${local.port}/calls/c-live/takeover/ws`, { type: "hello", resume: "tok1" });
    await until(() => again.json.some((m) => m.type === "resume"));
    expect(manager.resumes).toEqual(["c-live"]);
    c.ws.close();
    again.ws.close();
  });

  test("a call that can't be taken over is refused with the reason", async () => {
    manager.off = "that call has ended";
    const c = await open(`ws://127.0.0.1:${local.port}/calls/c-live/takeover/ws`, { type: "hello" });
    await until(c.closed);
    expect(c.json).toEqual([{ type: "error", message: "that call has ended" }]);
  });

  test("a cross-site page can't open the socket (the guard's Origin check)", async () => {
    const c = await open(`ws://127.0.0.1:${local.port}/calls/c-live/takeover/ws`, { type: "hello" }, { origin: "https://evil.example" });
    expect(c.opened).toBe(false);
    expect(manager.takeOvers).toEqual([]);
  });
});

describe("takeover security: no initData only behind the admin guard", () => {
  const base = () => `127.0.0.1:${access.port}`;

  test("the Telegram mount on any host still rejects a hello without (valid) initData", async () => {
    for (const hello of [{ type: "hello" }, { type: "hello", initData: "" }, { type: "hello", initData: "forged" }, { type: "hello", admin: true, mode: "admin" }]) {
      const c = await open(`ws://${base()}/takeover/ws/c-live`, hello);
      await until(c.closed);
      expect(c.json).toHaveLength(1);
      expect(c.json[0].type).toBe("error");
    }
    expect(manager.takeOvers).toEqual([]);
    // ...and the owner's initData still works there.
    const ok = await open(`ws://${base()}/takeover/ws/c-live`, { type: "hello", initData: "good" });
    await until(() => manager.takeOvers.length === 1);
    ok.ws.close();
  });

  test("the admin mount isn't served off the admin host", async () => {
    expect((await fetch(`http://${base()}/calls/c-live/takeover`)).status).toBe(404);
    const c = await open(`ws://${base()}/calls/c-live/takeover/ws`, { type: "hello" });
    expect(c.opened).toBe(false);
    expect(manager.takeOvers).toEqual([]);
  });

  test("on the admin host it requires the Access JWT, for the page and the WebSocket upgrade", async () => {
    const h = { host: ADMIN };
    expect((await fetch(`http://${base()}/calls/c-live/takeover`, { headers: h })).status).toBe(403);
    expect((await fetch(`http://${base()}/calls/c-live/takeover`, { headers: { ...h, "cf-access-jwt-assertion": "forged" } })).status).toBe(403);
    expect((await fetch(`http://${base()}/calls/c-live/takeover`, { headers: { ...h, "cf-access-jwt-assertion": jwt } })).status).toBe(200);

    const denied = await open(`ws://${base()}/calls/c-live/takeover/ws`, { type: "hello" }, h);
    expect(denied.opened).toBe(false);
    expect(manager.takeOvers).toEqual([]);

    const c = await open(`ws://${base()}/calls/c-live/takeover/ws`, { type: "hello" }, { ...h, "cf-access-jwt-assertion": jwt, origin: `https://${ADMIN}` });
    expect(c.opened).toBe(true);
    await until(() => manager.takeOvers.length === 1);
    c.ws.close();
  });
});

describe("takeover page script in admin mode", () => {
  test("runs without Telegram or initData: Start shows, closing the tab asks first", () => {
    const els = new Map<string, any>();
    const el = () => ({ textContent: "", hidden: true, disabled: false, onclick: null, setAttribute() {}, getAttribute: () => null });
    const document = {
      currentScript: null,
      body: { dataset: { mode: "admin" } },
      getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))),
    };
    const listeners: string[] = [];
    const window = { addEventListener: (t: string) => void listeners.push(t) };
    const location = { pathname: "/calls/call-1/takeover", protocol: "https:", host: "admin.example.com" };
    new Function("window", "document", "location", assets.get("takeover.js")!)(window, document, location);
    expect(els.get("status").textContent).not.toContain("Telegram");
    expect(els.get("start").hidden).toBe(false);
    expect(listeners).toContain("beforeunload");
  });
});
