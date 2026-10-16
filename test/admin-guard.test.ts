import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { readEnv, adminAuthFrom } from "../src/runtime/env";
import { adminGuard, type AdminAuth } from "../src/web/admin-guard";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ADMIN = "callsitter-admin.example.com";

async function rsaKey(kid: string) {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid, alg: "RS256", use: "sig" };
  const priv = { ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid, alg: "RS256" };
  return { pub, priv };
}

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  email: "owner@example.com",
  iat: nowS(),
  exp: nowS() + 600,
  ...over,
});

/** Fake JWKS endpoint that counts fetches; `keys` can be swapped to simulate rotation. */
function jwksServer(keys: object[]) {
  const s = {
    keys,
    fetches: 0,
    fetch: (async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
      s.fetches++;
      return Response.json({ keys: s.keys });
    }) as typeof fetch,
  };
  return s;
}

function appWith(auth: AdminAuth, f?: typeof fetch) {
  const app = new Hono();
  app.use("/*", adminGuard(auth, { fetch: f }));
  app.get("/", (c) => c.text("admin"));
  app.get("/ws", (c) => c.text("ws"));
  return app;
}

const access: AdminAuth = { mode: "access", adminHost: ADMIN, teamDomain: TEAM, aud: AUD };
const req = (app: Hono, path: string, headers: Record<string, string>) => app.request(`http://x${path}`, { headers });

describe("admin guard: access mode", async () => {
  const k1 = await rsaKey("k1");
  const good = await sign(claims(), k1.priv, "RS256");

  test("accepts a valid Access JWT on the admin host", async () => {
    const jw = jwksServer([k1.pub]);
    const res = await req(appWith(access, jw.fetch), "/", { host: ADMIN, "cf-access-jwt-assertion": good });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("admin");
  });

  test("rejects missing, forged, wrong-audience, wrong-issuer and expired tokens", async () => {
    const jw = jwksServer([k1.pub]);
    const app = appWith(access, jw.fetch);
    const other = await rsaKey("k1"); // same kid, different key: forged signature
    const cases = [
      undefined,
      "not-a-jwt",
      await sign(claims(), other.priv, "RS256"),
      await sign(claims({ aud: ["someone-else"] }), k1.priv, "RS256"),
      await sign(claims({ iss: "https://evil.cloudflareaccess.com" }), k1.priv, "RS256"),
      await sign(claims({ iat: nowS() - 7200, exp: nowS() - 3600 }), k1.priv, "RS256"),
    ];
    for (const t of cases) {
      const res = await req(app, "/", { host: ADMIN, ...(t ? { "cf-access-jwt-assertion": t } : {}) });
      expect(res.status).toBe(403);
    }
  });

  test("direct loopback and public hooks host are refused even with a valid token", async () => {
    const app = appWith(access, jwksServer([k1.pub]).fetch);
    for (const host of ["127.0.0.1:8787", "localhost", "hooks.example.com"]) {
      expect((await req(app, "/", { host, "cf-access-jwt-assertion": good })).status).toBe(404);
    }
  });

  test("checks Origin: cross-site WebSocket upgrade is refused", async () => {
    const app = appWith(access, jwksServer([k1.pub]).fetch);
    const h = { host: ADMIN, "cf-access-jwt-assertion": good };
    expect((await req(app, "/ws", { ...h, origin: `https://${ADMIN}` })).status).toBe(200);
    expect((await req(app, "/ws", { ...h, origin: "https://evil.example" })).status).toBe(403);
    expect((await req(app, "/ws", { ...h, origin: `http://${ADMIN}` })).status).toBe(403);
    expect((await req(app, "/ws", { ...h, origin: "null" })).status).toBe(403);
  });

  test("caches JWKS and refetches on key rotation", async () => {
    const jw = jwksServer([k1.pub]);
    const app = appWith(access, jw.fetch);
    for (let i = 0; i < 3; i++) await req(app, "/", { host: ADMIN, "cf-access-jwt-assertion": good });
    expect(jw.fetches).toBe(1);

    // Rotation: a new kid appears. The first miss is inside the 60 s refetch guard, so it's refused
    // without hammering the JWKS endpoint; the guard is what bounds refetches for junk kids.
    const k2 = await rsaKey("k2");
    jw.keys = [k1.pub, k2.pub];
    const rotated = await sign(claims(), k2.priv, "RS256");
    expect((await req(app, "/", { host: ADMIN, "cf-access-jwt-assertion": rotated })).status).toBe(403);
    expect(jw.fetches).toBe(1);
  });

  test("unknown kid triggers a refetch once the guard window has passed", async () => {
    let t = 1_000_000;
    const k2 = await rsaKey("k2");
    const jw = jwksServer([k1.pub]);
    const app = new Hono();
    app.use("/*", adminGuard(access, { fetch: jw.fetch, now: () => t }));
    app.get("/", (c) => c.text("admin"));
    await req(app, "/", { host: ADMIN, "cf-access-jwt-assertion": good });
    jw.keys = [k1.pub, k2.pub];
    t += 61_000;
    const rotated = await sign(claims(), k2.priv, "RS256");
    expect((await req(app, "/", { host: ADMIN, "cf-access-jwt-assertion": rotated })).status).toBe(200);
    expect(jw.fetches).toBe(2);
  });
});

describe("admin guard: none mode (local dev)", () => {
  const app = appWith({ mode: "none" });

  test("serves loopback hosts without a token", async () => {
    for (const host of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]) {
      expect((await req(app, "/", { host })).status).toBe(200);
    }
  });

  test("refuses other hosts (DNS rebinding) and cross-site origins", async () => {
    expect((await req(app, "/", { host: "rebind.evil.example" })).status).toBe(404);
    expect((await req(app, "/", { host: "hooks.example.com" })).status).toBe(404);
    expect((await req(app, "/ws", { host: "127.0.0.1:8787", origin: "https://evil.example" })).status).toBe(403);
    expect((await req(app, "/ws", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" })).status).toBe(200);
  });
});

describe("admin env", () => {
  const base = {
    PUBLIC_WS_BASE: "wss://hooks.example.com",
    TELNYX_API_KEY: "k",
    TELNYX_PUBLIC_KEY: "k",
    OPENAI_API_KEY: "k",
    TYPESAFE_API_KEY: "k",
    MEDIA_TOKEN_SECRET: "s".repeat(32),
  };

  test("access mode (the default) requires host, team domain and AUD", () => {
    expect(() => readEnv(base)).toThrow(/ADMIN_HOST[\s\S]*CF_ACCESS_TEAM_DOMAIN[\s\S]*CF_ACCESS_AUD/);
    const env = readEnv({ ...base, ADMIN_HOST: ADMIN, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD });
    expect(adminAuthFrom(env)).toEqual(access);
  });

  test("admin host must differ from the public hooks host", () => {
    expect(() => readEnv({ ...base, ADMIN_AUTH: "none", ADMIN_HOST: "hooks.example.com" })).toThrow(/must differ/);
  });

  test("none mode needs nothing else", () => {
    expect(adminAuthFrom(readEnv({ ...base, ADMIN_AUTH: "none" }))).toEqual({ mode: "none", adminHost: undefined });
  });

  test("blank vars count as unset; Telegram is optional", () => {
    const env = readEnv({ ...base, ADMIN_AUTH: "none", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", OWNER_NAME: "  " });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.OWNER_NAME).toBeUndefined();
    expect(() => readEnv({ ...base, CF_ACCESS_AUD: "" })).toThrow(/CF_ACCESS_AUD: required when ADMIN_AUTH=access/);
  });

  test("a public-calls chat needs the bot token, a valid id, and a chat of its own", () => {
    const tg = { ...base, ADMIN_AUTH: "none", TELEGRAM_BOT_TOKEN: "123456:ABC", TELEGRAM_CHAT_ID: "42" };
    expect(readEnv({ ...tg, TELEGRAM_PUBLIC_CHAT_ID: "-1001234" }).TELEGRAM_PUBLIC_CHAT_ID).toBe("-1001234");
    expect(readEnv({ ...tg, TELEGRAM_PUBLIC_CHAT_ID: "" }).TELEGRAM_PUBLIC_CHAT_ID).toBeUndefined();
    expect(() => readEnv({ ...base, ADMIN_AUTH: "none", TELEGRAM_PUBLIC_CHAT_ID: "-1001234" })).toThrow(/TELEGRAM_PUBLIC_CHAT_ID: needs TELEGRAM_BOT_TOKEN/);
    expect(() => readEnv({ ...tg, TELEGRAM_PUBLIC_CHAT_ID: "my group" })).toThrow(/TELEGRAM_PUBLIC_CHAT_ID: a numeric chat id/);
    expect(() => readEnv({ ...tg, TELEGRAM_PUBLIC_CHAT_ID: "42" })).toThrow(/TELEGRAM_PUBLIC_CHAT_ID: must differ/);
  });
});
