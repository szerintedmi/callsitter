import { describe, expect, test } from "bun:test";
import { publicHostRoutes } from "../src/web/app";
import { iconRoutes } from "../src/web/favicon";
import type { PublicDeps } from "../src/web/public";
import { takeoverRoutes, type TakeoverRoutesDeps } from "../src/web/takeover";

// The tunnels pass only the public host's paths their ingress lists; anything else gets a 404
// from Cloudflare (once: the bot page's script, so its waitlist never enabled). Every route the
// public host serves must be listed, in each committed tunnel config.

const app = publicHostRoutes({
  manager: { bus: { subscribe: () => () => {} } } as unknown as PublicDeps["manager"],
  repo: {} as PublicDeps["repo"],
  referee: {} as PublicDeps["referee"],
  config: () => ({}) as ReturnType<PublicDeps["config"]>,
  webrtc: {} as PublicDeps["webrtc"],
  clientAssets: async () => undefined,
  demoMedia: async () => undefined,
});
const takeover = takeoverRoutes({
  manager: {} as TakeoverRoutesDeps["manager"],
  verifyInitData: async () => null,
  ownerUserId: 1,
  upgradeWebSocket: (() => async () => {}) as unknown as TakeoverRoutesDeps["upgradeWebSocket"],
  clientAssets: async () => undefined,
});
// middleware (use, "*") isn't a path; a parameter becomes a sample value
const paths = [...new Set([...app.routes, ...iconRoutes().routes, ...takeover.routes].map((r) => r.path).filter((p) => !p.includes("*")))].map((p) =>
  p.replace(/:[a-z]+/gi, "x"),
);

describe("tunnel ingress", () => {
  test("the public host has routes to check", () => {
    for (const p of ["/bot", "/assets/site.js", "/call/waitlist", "/listen/x", "/takeover/x", "/takeover/ws/x", "/assets/takeover.js", "/assets/test-call-worklet.js"])
      expect(paths).toContain(p);
  });
  for (const file of ["deploy/vps/cloudflared.yml", "deploy/cloudflared.example.yml"])
    test(`${file} passes every public route`, async () => {
      const m = (await Bun.file(file).text()).match(/^\s*path: (.+)$/m);
      const re = new RegExp(m![1]!);
      expect(paths.filter((p) => !re.test(p))).toEqual([]);
      expect("/calls").not.toMatch(re);
      for (const p of ["/assets/calls.js", "/assets/test-call.js", "/takeover/x/y", "/test-call/ws"]) expect(p).not.toMatch(re);
    });
});
