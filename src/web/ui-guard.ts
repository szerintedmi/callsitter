import type { MiddlewareHandler } from "hono";
import { decodeHeader, verifyWithJwks } from "hono/utils/jwt/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

/**
 * How the UI is protected.
 * - `access`: served only on `uiHost` through Cloudflare Access; every request must carry a valid
 *   `Cf-Access-Jwt-Assertion`, so direct 127.0.0.1 hits (and anything bypassing Access) get 403.
 * - `none`: local dev; only loopback hostnames are served.
 * Both modes pin the Host header (DNS rebinding) and the Origin header (cross-site WebSocket reads of /ui/ws).
 */
export type UiAuth =
  | { mode: "access"; uiHost: string; teamDomain: string; aud: string }
  | { mode: "none"; uiHost?: string };

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between refetches triggered by an unknown `kid` (key rotation), so bad tokens can't hammer Cloudflare. */
const JWKS_MISS_REFETCH_MS = 60 * 1000;

export interface UiGuardDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export function uiHosts(auth: UiAuth): string[] {
  if (auth.mode === "access") return [auth.uiHost.toLowerCase()];
  return auth.uiHost ? [...LOOPBACK, auth.uiHost.toLowerCase()] : LOOPBACK;
}

export function hostOf(header: string | undefined): string | null {
  if (!header) return null;
  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function uiGuard(auth: UiAuth, deps: UiGuardDeps = {}): MiddlewareHandler {
  const hosts = uiHosts(auth);
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const jwks = auth.mode === "access" ? jwksCache(`https://${auth.teamDomain}/cdn-cgi/access/certs`, doFetch, now) : null;

  return async (c, next) => {
    const host = hostOf(c.req.header("host"));
    if (!host || !hosts.includes(host)) return c.notFound();

    const origin = c.req.header("origin");
    if (origin !== undefined && !originAllowed(origin, hosts, auth.mode)) return c.text("forbidden", 403);

    if (auth.mode === "access" && jwks) {
      const token = c.req.header("cf-access-jwt-assertion");
      if (!token) return c.text("forbidden", 403);
      try {
        const keys = await jwks.keysFor(decodeHeader(token).kid);
        await verifyWithJwks(token, {
          keys,
          allowedAlgorithms: ["RS256"],
          verification: { iss: `https://${auth.teamDomain}`, aud: auth.aud },
        });
      } catch {
        return c.text("forbidden", 403);
      }
    }
    await next();
  };
}

function originAllowed(origin: string, hosts: string[], mode: UiAuth["mode"]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (mode === "access" && u.protocol !== "https:") return false;
  return hosts.includes(u.hostname.toLowerCase());
}

function jwksCache(url: string, doFetch: typeof fetch, now: () => number) {
  let keys: HonoJsonWebKey[] = [];
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const refresh = () =>
    (inflight ??= (async () => {
      try {
        const res = await doFetch(url);
        if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
        const body = (await res.json()) as { keys?: HonoJsonWebKey[] };
        keys = body.keys ?? [];
        fetchedAt = now();
      } finally {
        inflight = null;
      }
    })());

  return {
    async keysFor(kid: unknown): Promise<HonoJsonWebKey[]> {
      const age = now() - fetchedAt;
      const known = keys.some((k) => k.kid === kid);
      if (age > JWKS_TTL_MS || (!known && age > JWKS_MISS_REFETCH_MS)) await refresh();
      return keys;
    },
  };
}
