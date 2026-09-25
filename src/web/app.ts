import { Hono } from "hono";
import { adminGuard, adminHosts, hostOf, type AdminAuth, type AdminGuardDeps } from "./admin-guard";
import { adminRoutes, type AdminDeps } from "./admin";
import { BrowserSipCalls, openAiSipRoutes, type SipRoutesDeps } from "./openai-sip";
import { telnyxRoutes, type TelnyxRoutesDeps } from "./telnyx";
import { testCallRoutes, type BrowserCalls, type BrowserSipDeps } from "./test-call";

export interface AppDeps extends TelnyxRoutesDeps, AdminDeps {
  /** admin UI protection: Cloudflare Access on its own hostname, or loopback-only for local dev */
  adminAuth: AdminAuth;
  adminGuardDeps?: AdminGuardDeps;
  browserCalls: BrowserCalls;
  testCallCloseGraceMs?: number;
  /** OpenAI SIP webhook; absent when OPENAI_PROJECT_ID/OPENAI_WEBHOOK_SECRET aren't set */
  openAiSip?: Omit<SipRoutesDeps, "manager" | "repo" | "config" | "browserSip">;
  browserSip?: BrowserSipDeps;
}

export function createApp(d: AppDeps) {
  const app = new Hono();

  // Webhooks, media and health: on any host (the tunnel only routes these paths on the public host).
  app.get("/healthz", (c) => c.text("ok"));
  app.route("/", telnyxRoutes(d));
  if (d.openAiSip) {
    app.route("/", openAiSipRoutes({ ...d.openAiSip, manager: d.manager, repo: d.repo, config: d.config, browserSip: d.browserSip?.calls ?? new BrowserSipCalls() }));
  }

  // The admin UI sits at the root of its own hostname, so the public host's root stays free for a
  // public UI and the two never share a browser origin. The guard also requires the Access JWT.
  const admin = new Hono();
  admin.use("*", adminGuard(d.adminAuth, d.adminGuardDeps));
  admin.route("/", adminRoutes(d));
  admin.route("/", testCallRoutes(d));

  const hosts = adminHosts(d.adminAuth);
  app.all("*", (c) => {
    const host = hostOf(c.req.header("host"));
    return host && hosts.includes(host) ? admin.fetch(c.req.raw, c.env) : c.notFound();
  });

  return app;
}
