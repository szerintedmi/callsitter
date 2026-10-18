import { Hono } from "hono";
import { adminGuard, adminHosts, hostOf, type AdminAuth, type AdminGuardDeps } from "./admin-guard";
import { adminRoutes, type AdminDeps } from "./admin";
import { analyticsAdminRoutes, analyticsRoutes } from "./analytics";
import { iconRoutes } from "./favicon";
import { BrowserSipCalls, openAiSipRoutes, type SipRoutesDeps } from "./openai-sip";
import { listenRoutes, type DemoMedia } from "./listen";
import { publicRoutes, type PublicDeps } from "./public";
import { adminTakeoverRoutes, takeoverRoutes, type TakeoverRoutesDeps } from "./takeover";
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
  /** the public "Scam me" page at the root of `host` (and at /public on the admin host); with
   * `demoMedia`, also the real-call players at /listen */
  publicPage?: Omit<PublicDeps, "manager" | "repo" | "clientAssets"> & { host: string; demoMedia?: DemoMedia };
  /** the owner's takeover Mini App (/takeover/…); absent without Telegram to a private chat. The
   * admin call page's takeover (/calls/<id>/takeover) doesn't need it. */
  takeover?: Omit<TakeoverRoutesDeps, "manager" | "upgradeWebSocket" | "clientAssets">;
}

export function createApp(d: AppDeps) {
  const app = new Hono();

  // Webhooks, media, health, the icons and the takeover Mini App (which can't pass Cloudflare
  // Access; it checks Telegram's initData): on any host (the tunnel only routes these paths on the public host).
  app.get("/healthz", (c) => c.text("ok"));
  app.route("/", iconRoutes());
  app.route("/", telnyxRoutes(d));
  if (d.takeover) {
    app.route("/", takeoverRoutes({ ...d.takeover, manager: d.manager, upgradeWebSocket: d.upgradeWebSocket, clientAssets: d.clientAssets }));
  }
  if (d.openAiSip) {
    app.route("/", openAiSipRoutes({ ...d.openAiSip, manager: d.manager, repo: d.repo, config: d.config, browserSip: d.browserSip?.calls ?? new BrowserSipCalls() }));
  }

  // The admin UI sits at the root of its own hostname, so the public host's root stays free for a
  // public UI and the two never share a browser origin. The guard also requires the Access JWT.
  const admin = new Hono();
  admin.use("*", adminGuard(d.adminAuth, d.adminGuardDeps));
  admin.route("/", adminRoutes({ ...d, takeoverOff: () => d.manager.takeoverOff() }));
  // The call page's takeover: the guard is the owner check, so its hello needs no initData. Never
  // mount it outside `admin` (test/takeover-admin.test.ts).
  admin.route("/", adminTakeoverRoutes({ manager: d.manager, upgradeWebSocket: d.upgradeWebSocket }));
  admin.route("/", analyticsAdminRoutes({ repo: d.repo, config: () => d.config.get() }));
  admin.route("/", testCallRoutes(d));

  const pub = d.publicPage ? publicHostRoutes({ ...d.publicPage, manager: d.manager, repo: d.repo, clientAssets: d.clientAssets }) : null;
  if (pub) {
    admin.get("/public/", (c) => c.redirect("/public"));
    // The owner's previews aren't visitors: their page analytics are dropped.
    admin.post("/public/call/e", (c) => c.body(null, 204));
    admin.route("/public", pub);
  }
  const publicHost = d.publicPage?.host.toLowerCase();

  const hosts = adminHosts(d.adminAuth);
  app.all("*", (c) => {
    const host = hostOf(c.req.header("host"));
    if (pub && host === publicHost) return pub.fetch(c.req.raw, c.env);
    return host && hosts.includes(host) ? admin.fetch(c.req.raw, c.env) : c.notFound();
  });

  return app;
}

/**
 * Everything the public host serves besides the webhooks and icons: the pages, their scripts and
 * the endpoints those call. The tunnels only pass the paths they list (test/tunnel.test.ts).
 */
export function publicHostRoutes(d: Omit<PublicDeps, "realCalls" | "mediaVersions"> & { demoMedia?: DemoMedia }) {
  const pub = publicRoutes({ ...d, realCalls: !!d.demoMedia, mediaVersions: d.demoMedia?.versions });
  if (d.demoMedia) pub.route("/", listenRoutes({ clientAssets: d.clientAssets, media: d.demoMedia }));
  pub.route("/", analyticsRoutes({ repo: d.repo, config: d.config }));
  return pub;
}
