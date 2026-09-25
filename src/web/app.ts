import { Hono } from "hono";
import { BrowserSipCalls, openAiSipRoutes, type SipRoutesDeps } from "./openai-sip";
import { telnyxRoutes, type TelnyxRoutesDeps } from "./telnyx";
import { testCallRoutes, type BrowserCalls, type BrowserSipDeps } from "./test-call";
import { uiGuard, type UiAuth, type UiGuardDeps } from "./ui-guard";
import { uiRoutes, type UiDeps } from "./ui";

export interface AppDeps extends TelnyxRoutesDeps, UiDeps {
  /** UI protection: Cloudflare Access on its own hostname, or loopback-only for local dev */
  uiAuth: UiAuth;
  uiGuardDeps?: UiGuardDeps;
  browserCalls: BrowserCalls;
  testCallCloseGraceMs?: number;
  /** OpenAI SIP webhook; absent when OPENAI_PROJECT_ID/OPENAI_WEBHOOK_SECRET aren't set */
  openAiSip?: Omit<SipRoutesDeps, "manager" | "repo" | "config" | "browserSip">;
  browserSip?: BrowserSipDeps;
}

export function createApp(d: AppDeps) {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));
  app.route("/", telnyxRoutes(d));
  if (d.openAiSip) {
    app.route("/", openAiSipRoutes({ ...d.openAiSip, manager: d.manager, repo: d.repo, config: d.config, browserSip: d.browserSip?.calls ?? new BrowserSipCalls() }));
  }

  // Both tunnel hostnames reach the same origin, so the guard pins the UI to its own host
  // (the public hooks host gets 404) and, in `access` mode, requires a valid Access JWT.
  const guard = uiGuard(d.uiAuth, d.uiGuardDeps);
  app.use("/ui/*", guard);
  app.route("/ui", uiRoutes(d));
  app.route("/ui", testCallRoutes(d));
  app.get("/", guard, (c) => c.redirect("/ui"));

  return app;
}
