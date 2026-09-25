import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { readEnv, uiAuthFrom } from "../src/runtime/env";
import { uiGuard, type UiAuth } from "../src/web/ui-guard";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const UI = "scamsitter-ui.example.com";

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

function appWith(auth: UiAuth, f?: typeof fetch) {
  const app = new Hono();
  app.use("/ui/*", uiGuard(auth, { fetch: f }));
  app.get("/ui", (c) => c.text("ui"));
  app.get("/ui/ws", (c) => c.text("ws"));
  return app;
}

const access: UiAuth = { mode: "access", uiHost: UI, teamDomain: TEAM, aud: AUD };
const req = (app: Hono, path: string, headers: Record<string, string>) => app.request(`http://x${path}`, { headers });

describe("UI guard: access mode", async () => {
  const k1 = await rsaKey("k1");
  const good = await sign(claims(), k1.priv, "RS256");

  test("accepts a valid Access JWT on the UI host", async () => {
    const jw = jwksServer([k1.pub]);
    const res = await req(appWith(access, jw.fetch), "/ui", { host: UI, "cf-access-jwt-assertion": good });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ui");
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
      const res = await req(app, "/ui", { host: UI, ...(t ? { "cf-access-jwt-assertion": t } : {}) });
      expect(res.status).toBe(403);
    }
  });

  test("direct loopback and public hooks host are refused even with a valid token", async () => {
    const app = appWith(access, jwksServer([k1.pub]).fetch);
    for (const host of ["127.0.0.1:8787", "localhost", "hooks.example.com"]) {
      expect((await req(app, "/ui", { host, "cf-access-jwt-assertion": good })).status).toBe(404);
    }
  });

  test("checks Origin: cross-site WebSocket upgrade is refused", async () => {
    const app = appWith(access, jwksServer([k1.pub]).fetch);
    const h = { host: UI, "cf-access-jwt-assertion": good };
    expect((await req(app, "/ui/ws", { ...h, origin: `https://${UI}` })).status).toBe(200);
    expect((await req(app, "/ui/ws", { ...h, origin: "https://evil.example" })).status).toBe(403);
    expect((await req(app, "/ui/ws", { ...h, origin: `http://${UI}` })).status).toBe(403);
    expect((await req(app, "/ui/ws", { ...h, origin: "null" })).status).toBe(403);
  });

  test("caches JWKS and refetches on key rotation", async () => {
    const jw = jwksServer([k1.pub]);
    const app = appWith(access, jw.fetch);
    for (let i = 0; i < 3; i++) await req(app, "/ui", { host: UI, "cf-access-jwt-assertion": good });
    expect(jw.fetches).toBe(1);

    // Rotation: a new kid appears. The first miss is inside the 60 s refetch guard, so it's refused
    // without hammering the JWKS endpoint; the guard is what bounds refetches for junk kids.
    const k2 = await rsaKey("k2");
    jw.keys = [k1.pub, k2.pub];
    const rotated = await sign(claims(), k2.priv, "RS256");
    expect((await req(app, "/ui", { host: UI, "cf-access-jwt-assertion": rotated })).status).toBe(403);
    expect(jw.fetches).toBe(1);
  });

  test("unknown kid triggers a refetch once the guard window has passed", async () => {
    let t = 1_000_000;
    const k2 = await rsaKey("k2");
    const jw = jwksServer([k1.pub]);
    const app = new Hono();
    app.use("/ui/*", uiGuard(access, { fetch: jw.fetch, now: () => t }));
    app.get("/ui", (c) => c.text("ui"));
    await req(app, "/ui", { host: UI, "cf-access-jwt-assertion": good });
    jw.keys = [k1.pub, k2.pub];
    t += 61_000;
    const rotated = await sign(claims(), k2.priv, "RS256");
    expect((await req(app, "/ui", { host: UI, "cf-access-jwt-assertion": rotated })).status).toBe(200);
    expect(jw.fetches).toBe(2);
  });
});

describe("UI guard: none mode (local dev)", () => {
  const app = appWith({ mode: "none" });

  test("serves loopback hosts without a token", async () => {
    for (const host of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]) {
      expect((await req(app, "/ui", { host })).status).toBe(200);
    }
  });

  test("refuses other hosts (DNS rebinding) and cross-site origins", async () => {
    expect((await req(app, "/ui", { host: "rebind.evil.example" })).status).toBe(404);
    expect((await req(app, "/ui", { host: "hooks.example.com" })).status).toBe(404);
    expect((await req(app, "/ui/ws", { host: "127.0.0.1:8787", origin: "https://evil.example" })).status).toBe(403);
    expect((await req(app, "/ui/ws", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" })).status).toBe(200);
  });
});

describe("UI env", () => {
  const base = {
    PUBLIC_WS_BASE: "wss://hooks.example.com",
    TELNYX_API_KEY: "k",
    TELNYX_PUBLIC_KEY: "k",
    TELNYX_SMS_FROM: "ScamSitter",
    OPENAI_API_KEY: "k",
    TYPESAFE_API_KEY: "k",
    MEDIA_TOKEN_SECRET: "s".repeat(32),
  };

  test("access mode (the default) requires host, team domain and AUD", () => {
    expect(() => readEnv(base)).toThrow(/UI_HOST[\s\S]*CF_ACCESS_TEAM_DOMAIN[\s\S]*CF_ACCESS_AUD/);
    const env = readEnv({ ...base, UI_HOST: UI, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD });
    expect(uiAuthFrom(env)).toEqual(access);
  });

  test("UI host must differ from the public hooks host", () => {
    expect(() => readEnv({ ...base, UI_AUTH: "none", UI_HOST: "hooks.example.com" })).toThrow(/must differ/);
  });

  test("none mode needs nothing else", () => {
    expect(uiAuthFrom(readEnv({ ...base, UI_AUTH: "none" }))).toEqual({ mode: "none", uiHost: undefined });
  });

  test("blank vars count as unset; SMS sender is optional", () => {
    const env = readEnv({ ...base, UI_AUTH: "none", TELNYX_SMS_FROM: "", OWNER_NAME: "  " });
    expect(env.TELNYX_SMS_FROM).toBeUndefined();
    expect(env.OWNER_NAME).toBeUndefined();
    expect(() => readEnv({ ...base, CF_ACCESS_AUD: "" })).toThrow(/CF_ACCESS_AUD: required when UI_AUTH=access/);
  });
});
