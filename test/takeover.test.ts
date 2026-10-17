import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { OwnerAudioLeg, OwnerPageStats, TakeoverHandle } from "../src/core/ports";
import { buildClient } from "../src/runtime/client-assets";
import { takeoverRoutes, type TakeoverManager } from "../src/web/takeover";

// The takeover page and its socket, against a fake CallManager and a fake initData check
// (src/core/telegram-auth.ts has its own tests).

const OWNER = 4242;
const assets = await buildClient();

class FakeManager implements TakeoverManager {
  why: string | null = null;
  fail?: Error;
  leg?: OwnerAudioLeg;
  takeOvers: string[] = [];
  hangups: string[] = [];
  resumes: string[] = [];
  audio: Int16Array[] = [];
  stats: OwnerPageStats[] = [];
  left = 0;
  canTakeOver = (_callId: string) => this.why;
  async takeOver(callId: string, leg: OwnerAudioLeg): Promise<TakeoverHandle> {
    if (this.fail) throw this.fail;
    this.takeOvers.push(callId);
    return this.attach(callId, leg);
  }
  resumeTakeover(callId: string, token: string, leg: OwnerAudioLeg): TakeoverHandle {
    if (token !== `tok${this.takeOvers.length + this.resumes.length}`) throw new Error("that connection was replaced");
    this.resumes.push(callId);
    return this.attach(callId, leg);
  }
  private attach(callId: string, leg: OwnerAudioLeg): TakeoverHandle {
    this.leg = leg;
    leg.notify({ type: "connecting" });
    return {
      ownerAudio: (pcm) => void this.audio.push(pcm),
      ownerLeft: () => void this.left++,
      pageStats: (s) => void this.stats.push(s),
      hangUp: () => {
        this.hangups.push(callId);
        leg.notify({ type: "ended", reason: "the owner hung up" });
        leg.close();
      },
      reconnectToken: `tok${this.takeOvers.length + this.resumes.length}`,
    };
  }
}

let manager: FakeManager;
/** While set, the initData check waits for it (a slow login check). */
let verifyGate: Promise<void> | null = null;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const app = takeoverRoutes({
    manager: {
      canTakeOver: (id) => manager.canTakeOver(id),
      takeOver: (id, leg) => manager.takeOver(id, leg),
      resumeTakeover: (id, token, leg) => manager.resumeTakeover(id, token, leg),
    },
    // "good:<user id>" is valid initData for that user; anything else isn't
    verifyInitData: async (s) => {
      await verifyGate;
      return s.startsWith("good:") ? { userId: Number(s.slice(5)) } : null;
    },
    ownerUserId: OWNER,
    upgradeWebSocket,
    clientAssets: async (name) => assets.get(name),
    helloTimeoutMs: 200,
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
});
afterAll(() => server?.stop(true));
beforeEach(() => {
  manager = new FakeManager();
  verifyGate = null;
});

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

/** Opens the socket, sends `hello` (unless null) and collects what comes back. */
async function open(hello: unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/takeover/ws/call-1`);
  ws.binaryType = "arraybuffer";
  const json: any[] = [];
  const binary: Int16Array[] = [];
  let closed = false;
  ws.onmessage = (m) => (typeof m.data === "string" ? json.push(JSON.parse(m.data)) : binary.push(new Int16Array(m.data as ArrayBuffer)));
  ws.onclose = () => (closed = true);
  await new Promise((r) => (ws.onopen = r));
  if (hello !== null) ws.send(JSON.stringify(hello));
  return { ws, json, binary, closed: () => closed };
}

describe("takeover page", () => {
  test("serves the Mini App page and its scripts", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/takeover/call-1`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("https://telegram.org/js/telegram-web-app.js");
    expect(html).toContain("/assets/takeover.js?v=");
    for (const name of ["takeover.js", "test-call-worklet.js"]) {
      const a = await fetch(`http://127.0.0.1:${server.port}/assets/${name}`);
      expect(a.status).toBe(200);
      expect(a.headers.get("content-type")).toContain("javascript");
    }
  });
});

describe("takeover socket", () => {
  for (const [name, hello] of [
    ["no initData", { type: "hello" }],
    ["bad initData", { type: "hello", initData: "forged" }],
    ["someone else", { type: "hello", initData: "good:7" }],
  ] as const)
    test(`rejects a hello with ${name}`, async () => {
      const c = await open(hello);
      await until(c.closed);
      expect(c.json).toHaveLength(1);
      expect(c.json[0].type).toBe("error");
      expect(manager.takeOvers).toEqual([]);
    });

  test("rejects a call that can't be taken over, with the reason", async () => {
    manager.why = "the call has ended";
    const c = await open({ type: "hello", initData: `good:${OWNER}` });
    await until(c.closed);
    expect(c.json).toEqual([{ type: "error", message: "the call has ended" }]);
    expect(manager.takeOvers).toEqual([]);
  });

  test("a takeover that fails to start is reported", async () => {
    manager.fail = new Error("refer failed");
    const c = await open({ type: "hello", initData: `good:${OWNER}` });
    await until(c.closed);
    expect(c.json).toEqual([{ type: "error", message: "refer failed" }]);
  });

  test("a page that closes while its login is checked doesn't take the call over", async () => {
    let pass!: () => void;
    verifyGate = new Promise((r) => (pass = r));
    let checked = 0;
    manager.canTakeOver = () => (checked++, null);
    const c = await open({ type: "hello", initData: `good:${OWNER}` });
    await Bun.sleep(20);
    c.ws.close();
    await until(c.closed);
    await Bun.sleep(20);
    pass();
    await Bun.sleep(50);
    expect(checked).toBe(0);
    expect(manager.takeOvers).toEqual([]);
    expect(manager.left).toBe(0);
    expect(manager.hangups).toEqual([]);
  });

  test("closes a socket that never says hello", async () => {
    const c = await open(null);
    await until(c.closed);
    expect(c.json[0].type).toBe("error");
  });

  test("the owner's hello takes the call over; audio passes both ways; closing is ownerLeft", async () => {
    const c = await open({ type: "hello", initData: `good:${OWNER}` });
    await until(() => c.json.length > 0);
    expect(manager.takeOvers).toEqual(["call-1"]);
    await until(() => c.json.length === 2);
    expect(c.json).toEqual([{ type: "connecting" }, { type: "resume", token: "tok1" }]);

    // caller → page, from a view into a larger buffer
    const big = new Int16Array([9, 1, 2, 3, 9]);
    manager.leg!.sendAudio(big.subarray(1, 4));
    manager.leg!.notify({ type: "live" });
    await until(() => c.binary.length === 1 && c.json.length === 3);
    expect([...c.binary[0]!]).toEqual([1, 2, 3]);
    expect(c.json[2]).toEqual({ type: "live" });

    // page → core
    c.ws.send(new Int16Array([-5, 6, 32767]).buffer);
    await until(() => manager.audio.length === 1);
    expect([...manager.audio[0]!]).toEqual([-5, 6, 32767]);

    c.ws.close();
    await until(() => manager.left === 1);
    expect(manager.hangups).toEqual([]);
  });

  test("hangup ends the call at once", async () => {
    const c = await open({ type: "hello", initData: `good:${OWNER}` });
    await until(() => manager.takeOvers.length === 1 && c.json.length > 0);
    c.ws.send(JSON.stringify({ type: "hangup" }));
    await until(c.closed);
    expect(manager.hangups).toEqual(["call-1"]);
    expect(c.json.at(-1)).toEqual({ type: "ended", reason: "the owner hung up" });
    await until(() => manager.left === 1);
  });

  test("a reconnect presents its resume token instead of (stale) initData; a wrong one needs fresh initData", async () => {
    const c = await open({ type: "hello", initData: `good:${OWNER}` });
    await until(() => c.json.some((m) => m.type === "resume"));
    const stale = await open({ type: "hello", initData: "stale", resume: "tok1" });
    await until(() => manager.resumes.length === 1 && stale.json.some((m) => m.type === "resume"));
    expect(stale.json.at(-1)).toEqual({ type: "resume", token: "tok2" });
    // The first connection's token was replaced.
    const old = await open({ type: "hello", initData: "stale", resume: "tok1" });
    await until(old.closed);
    expect(old.json[0].type).toBe("error");
    expect(manager.resumes).toEqual(["call-1"]);
    stale.ws.close();
    c.ws.close();
  });

  test("page stats reach the core, with bad counters as 0; ignored before the takeover started", async () => {
    const c = await open(null);
    c.ws.send(JSON.stringify({ type: "stats", sentFrames: 1, underruns: 0, mutedMs: 0 }));
    c.ws.send(JSON.stringify({ type: "hello", initData: `good:${OWNER}` }));
    await until(() => c.json.some((m) => m.type === "resume"));
    c.ws.send(JSON.stringify({ type: "stats", sentFrames: 250, underruns: "3", mutedMs: -1 }));
    await until(() => manager.stats.length === 1);
    expect(manager.stats).toEqual([{ sentFrames: 250, underruns: 0, mutedMs: 0 }]);
    c.ws.close();
  });

  test("binary frames before the takeover started are dropped", async () => {
    const c = await open(null);
    c.ws.send(new Int16Array([1, 2]).buffer);
    c.ws.send(JSON.stringify({ type: "hello", initData: `good:${OWNER}` }));
    await until(() => manager.takeOvers.length === 1 && c.json.length > 0);
    c.ws.send(new Int16Array([3]).buffer);
    await until(() => manager.audio.length === 1);
    expect([...manager.audio[0]!]).toEqual([3]);
    c.ws.close();
  });
});

describe("takeover page script", () => {
  test("outside Telegram it asks to open the page from the Telegram button", () => {
    const els = new Map<string, any>();
    const el = () => ({ textContent: "", hidden: true, disabled: false, onclick: null, setAttribute() {}, getAttribute: () => null });
    const document = { currentScript: null, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))) };
    const window = {};
    const location = { pathname: "/takeover/call-1", protocol: "https:", host: "hooks.example.com" };
    new Function("window", "document", "location", assets.get("takeover.js")!)(window, document, location);
    expect(els.get("status").textContent).toBe("Open this from the Telegram button.");
    expect(els.get("start").hidden).toBe(true);
  });
});
