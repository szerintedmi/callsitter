import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { demoStats, isBot, median, parseBeacon, RateLimiter, parseUserAgent, type PageEventRecord } from "../src/core/analytics";

// The public site's page analytics (src/core/analytics.ts): checking the pages' batches, the
// dashboard's sums over them (listening time: the largest `watch` per visit, page load and
// recording, loads added up), and the page side (src/web/client/track.ts). The endpoint itself:
// public.test.ts.

const DEMOS = ["areyouai", "police-scam", "crypto-bot", "electrician"];
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("beacons", () => {
  const ctx = { now: 1_000_000, ip: "203.0.113.7", userAgent: SAFARI, acceptLanguage: "de-DE,de;q=0.9", country: "DE", city: "Berlin", host: "callsitter.example", demos: DEMOS };
  const view = (props: Record<string, unknown>) => ({ visit: "v".repeat(16), load: "l".repeat(16), now: 500, events: [{ type: "view", t: 500, path: "/", props }] });
  const source = (props: Record<string, unknown>) => {
    const r = parseBeacon(view(props), ctx);
    if ("error" in r) throw new Error(r.error);
    return r.rows[0]!.props;
  };

  test("a view's source: utm_source, then ?ref=, then the referrer's host (not this site's)", () => {
    expect(source({ referrer: "https://www.reddit.com/r/x", utm_source: "Newsletter", ref: "gh" })).toMatchObject({ refHost: "reddit.com", source: "newsletter" });
    expect(source({ referrer: "https://www.reddit.com/r/x", ref: "gh" })).toMatchObject({ source: "gh" });
    expect(source({ referrer: "https://callsitter.example/play" })).not.toHaveProperty("source");
    expect(source({ referrer: null })).not.toHaveProperty("refHost");
  });

  test("events are dated by the server, at most a day back, with the visitor's IP, user agent and location", () => {
    const r = parseBeacon({ visit: "v".repeat(16), load: "l".repeat(16), now: 10_000, events: [{ type: "click", t: 9_000 }, { type: "click", t: -1e12 }, { type: "click", t: 20_000 }] }, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.rows.map((x) => x.at)).toEqual([999_000, 1_000_000 - 86_400_000, 1_000_000]);
    expect(r.rows[0]).toMatchObject({
      ip: "203.0.113.7",
      userAgent: SAFARI,
      browser: "Safari",
      browserVersion: "18.0",
      os: "macOS",
      osVersion: "10.15.7",
      device: "desktop",
      mobile: false,
      acceptLanguage: "de-DE,de;q=0.9",
      country: "DE",
      city: "Berlin",
      region: null,
      props: {},
    });
  });

  test("bots and user agents", () => {
    expect(isBot(undefined)).toBe(true);
    expect(isBot("curl/8.4.0")).toBe(true);
    expect(isBot("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(true);
    expect(isBot("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36")).toBe(true);
    expect(isBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isBot(SAFARI)).toBe(false);
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toEqual({
      browser: "Chrome",
      browserVersion: "130.0",
      os: "Android",
      osVersion: "14",
      device: "mobile",
      mobile: true,
    });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toMatchObject({ browser: "Edge", browserVersion: "130.0", os: "Windows", device: "desktop" });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0").browser).toBe("Firefox");
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toMatchObject({ browser: "Safari", os: "iOS", osVersion: "17.4", device: "mobile" });
    expect(parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1")).toMatchObject({ browser: "Chrome", os: "iOS", device: "tablet" });
  });

  test("the rate limit slides over a minute, per key", () => {
    const l = new RateLimiter(() => 2);
    expect([l.allow("a", 0), l.allow("a", 10), l.allow("a", 20), l.allow("b", 20)]).toEqual([true, true, false, true]);
    expect(l.allow("a", 60_001)).toBe(true);
  });

  test("medians and per-recording stats", () => {
    expect([median([]), median([3]), median([5, 1, 3]), median([4, 1, 3, 2])]).toEqual([0, 3, 3, 2.5]);
    const stats = demoStats(
      [
        { visitId: "a", demo: "electrician", seconds: 10, completed: false },
        { visitId: "b", demo: "electrician", seconds: 30, completed: true },
        { visitId: "c", demo: "electrician", seconds: 0.4, completed: false },
      ],
      new Map([["electrician", 4]]),
      ["areyouai", "electrician"],
    );
    expect(stats).toEqual([
      { demo: "areyouai", plays: 0, listeners: 0, avgSeconds: 0, medianSeconds: 0, completionRate: 0 },
      { demo: "electrician", plays: 4, listeners: 2, avgSeconds: 20, medianSeconds: 20, completionRate: 0.5 },
    ]);
  });
});

describe("the dashboard's sums (SqliteRepo)", () => {
  const T = Date.UTC(2026, 9, 10, 12);
  const ev = (visitId: string, loadId: string, at: number, type: PageEventRecord["type"], demo: string | null, props: PageEventRecord["props"] = {}, more: Partial<PageEventRecord> = {}): PageEventRecord => ({
    visitId,
    loadId,
    at,
    type,
    path: "/",
    demo,
    props,
    ip: "203.0.113.1",
    userAgent: "ua",
    browser: "Safari",
    browserVersion: "18.0",
    os: "macOS",
    osVersion: null,
    device: "desktop",
    mobile: false,
    acceptLanguage: null,
    country: "GB",
    city: null,
    region: null,
    ...more,
  });
  const watch = (played: number, completed = false) => ({ playedSeconds: played, maxPosition: played, duration: 100, completed });

  async function seeded() {
    const repo = new SqliteRepo(openSqlite(":memory:"));
    await repo.addPageEvents([
      // before the range
      ev("old", "o1", T - 10, "view", null),
      // A: a view from HN; police-scam heard 10 then 30 s in one load (its totals grow), 20 s after
      // a reload; all of the electrician
      ev("A", "a1", T, "view", null, { referrer: "https://news.ycombinator.com/", refHost: "news.ycombinator.com", source: "news.ycombinator.com" }, { mobile: true, device: "mobile" }),
      ev("A", "a1", T + 1, "play", "police-scam", { position: 0 }),
      ev("A", "a1", T + 2, "pause", "police-scam", { position: 12 }),
      ev("A", "a1", T + 3, "play", "police-scam", { position: 12 }),
      ev("A", "a1", T + 4, "watch", "police-scam", watch(10)),
      ev("A", "a1", T + 5, "watch", "police-scam", watch(30)),
      ev("A", "a1", T + 6, "click", null, { action: "tab", target: "police-scam" }),
      ev("A", "a1", T + 7, "click", null, { action: "tab", target: "police-scam" }),
      ev("A", "a2", T + 8, "view", null),
      ev("A", "a2", T + 9, "watch", "police-scam", watch(20)),
      ev("A", "a2", T + 10, "play", "electrician", { position: 0 }),
      ev("A", "a2", T + 11, "watch", "electrician", watch(100, true)),
      // B: from a tweet, half a second heard
      ev("B", "b1", T + 20, "view", null, { utm_source: "twitter", source: "twitter" }, { country: "US" }),
      ev("B", "b1", T + 21, "watch", "police-scam", watch(0.5)),
      ev("B", "b1", T + 22, "click", null, { action: "link", target: "/play" }),
      // C: direct, the next day; heard 90 s of police-scam
      ev("C", "c1", T + 86_400_000, "view", null),
      ev("C", "c1", T + 86_400_001, "play", "police-scam", { position: 0 }),
      ev("C", "c1", T + 86_400_002, "watch", "police-scam", watch(90, true)),
    ]);
    return repo;
  }

  test("totals, recordings, clicks, sources and days", async () => {
    const repo = await seeded();
    const s = await repo.pageStats(T, DEMOS);
    expect([s.visits, s.views, s.listeningVisits, s.listenSeconds]).toEqual([3, 4, 2, 30 + 20 + 100 + 0.5 + 90]);
    const police = s.demos.find((d) => d.demo === "police-scam")!;
    // A: 30 + 20 over two loads; C: 90. B's half second isn't a listen.
    expect(police).toEqual({ demo: "police-scam", plays: 2, listeners: 2, avgSeconds: 70, medianSeconds: 70, completionRate: 0.5 });
    expect(s.demos.find((d) => d.demo === "electrician")).toMatchObject({ plays: 1, listeners: 1, completionRate: 1 });
    expect(s.demos.map((d) => d.demo)).toEqual(DEMOS);
    expect(s.clicks).toEqual([
      { action: "tab", target: "police-scam", n: 2 },
      { action: "link", target: "/play", n: 1 },
    ]);
    expect(s.sources).toEqual([
      { name: "(direct)", n: 1 },
      { name: "news.ycombinator.com", n: 1 },
      { name: "twitter", n: 1 },
    ]);
    expect(s.referrers).toEqual([{ name: "news.ycombinator.com", n: 1 }]);
    expect(s.countries).toEqual([
      { name: "GB", n: 2 },
      { name: "US", n: 1 },
    ]);
    expect(s.devices).toEqual([
      { name: "desktop", n: 2 },
      { name: "mobile", n: 1 },
    ]);
    expect(s.days).toEqual([
      { day: "2026-10-10", visits: 2, views: 3, listeners: 1 },
      { day: "2026-10-11", visits: 1, views: 1, listeners: 1 },
    ]);
  });

  test("recent visits, a visit's events, and pruning", async () => {
    const repo = await seeded();
    const visits = await repo.pageVisits(T, 10);
    expect(visits.map((v) => v.visitId)).toEqual(["C", "B", "A"]);
    expect(visits[2]).toMatchObject({
      firstAt: T,
      source: "news.ycombinator.com",
      views: 2,
      clicks: 2,
      listened: [
        { demo: "electrician", seconds: 100 },
        { demo: "police-scam", seconds: 50 },
      ],
    });
    expect(visits[1]!.listened).toEqual([]);
    expect((await repo.pageVisits(T, 1)).map((v) => v.visitId)).toEqual(["C"]);
    const a = await repo.pageVisit("A");
    expect(a.map((e) => e.type)).toEqual(["view", "play", "pause", "play", "watch", "watch", "click", "click", "view", "watch", "play", "watch"]);
    expect(a[1]).toEqual(ev("A", "a1", T + 1, "play", "police-scam", { position: 0 }));
    expect(await repo.prunePageEvents(T)).toBe(1);
    expect(await repo.pageVisit("old")).toEqual([]);
    expect((await repo.pageStats(0, DEMOS)).visits).toBe(3);
  });
});

describe("the page side (track.ts)", () => {
  // No imports, so it runs as a plain script once its `export`s are dropped.
  const source = new Bun.Transpiler({ loader: "ts" })
    .transformSync(readFileSync(new URL("../src/web/client/track.ts", import.meta.url), "utf8"))
    .replace(/^export /gm, "");

  function page(o: { analytics?: boolean } = {}) {
    const beacons: { url: string; body: Blob }[] = [];
    const on = new Map<string, () => void>();
    const timers: (() => void)[] = [];
    const ctx: Record<string, unknown> = {
      document: {
        body: { dataset: o.analytics === false ? {} : { analytics: "1" } },
        referrer: "https://news.ycombinator.com/",
        visibilityState: "visible",
        addEventListener: (type: string, f: () => void) => on.set(`doc:${type}`, f),
      },
      location: { search: "?utm_source=tw&x=1", pathname: "/listen/police-scam", origin: "https://s.test" },
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 3,
      screen: { width: 390, height: 844 },
      matchMedia: () => ({ matches: false }),
      Intl,
      navigator: { language: "en-GB", languages: ["en-GB", "en"], platform: "iPhone", maxTouchPoints: 5, sendBeacon: (url: string, body: Blob) => (beacons.push({ url, body }), true) },
      // private mode: storage throws
      sessionStorage: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } },
      addEventListener: (type: string, f: () => void) => on.set(type, f),
      setTimeout: (f: () => void) => timers.push(f),
      clearTimeout: () => {},
      crypto, btoa, Blob, URLSearchParams, Date, Math, JSON,
    };
    const api = runInNewContext(`${source};({ startTracking, track, onHide, mergeSpans, spanSeconds })`, ctx) as {
      startTracking(base: string): boolean;
      track(type: string, props?: Record<string, unknown>, demo?: string): void;
      onHide(f: () => void): void;
      mergeSpans(s: [number, number][]): [number, number][];
      spanSeconds(s: [number, number][]): number;
    };
    const sent = async () => Promise.all(beacons.map(async (b) => ({ url: b.url, ...JSON.parse(await b.body.text()) })));
    return { api, on, timers, sent };
  }

  test("parts heard twice count once", () => {
    const { api } = page();
    expect(api.mergeSpans([[5, 10], [0, 2], [8, 12], [12, 13]])).toEqual([[0, 2], [5, 13]]);
    expect(api.spanSeconds([[0, 10], [5, 15], [20, 21]])).toBe(16);
    expect(api.spanSeconds([])).toBe(0);
  });

  test("the view, then events in batches; final totals just before the page hides", async () => {
    const p = page();
    expect(p.api.startTracking("/")).toBe(true);
    p.api.track("play", { position: 0 }, "police-scam");
    p.api.onHide(() => p.api.track("watch", { playedSeconds: 12 }, "police-scam"));
    expect(await p.sent()).toEqual([]);
    p.on.get("pagehide")!();
    const [b] = await p.sent();
    expect(b.url).toBe("/call/e");
    expect(b.visit).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b.events.map((e: any) => e.type)).toEqual(["view", "play", "watch"]);
    expect(b.events[0].props).toMatchObject({ referrer: "https://news.ycombinator.com/", vw: 390, vh: 844, sw: 390, dpr: 3, lang: "en-GB", langs: "en-GB,en", platform: "iPhone", touch: true, utm_source: "tw" });
    expect(b.events[0].props).not.toHaveProperty("x");
    expect(b.events[2]).toMatchObject({ demo: "police-scam", path: "/listen/police-scam", props: { playedSeconds: 12 } });
    // a full batch goes at once
    for (let i = 0; i < 8; i++) p.api.track("click", { action: "seek" });
    expect((await p.sent()).length).toBe(2);
  });

  test("nothing is sent unless the page turns it on", async () => {
    const p = page({ analytics: false });
    expect(p.api.startTracking("/")).toBe(false);
    p.api.track("click", { action: "x" });
    expect(p.on.size).toBe(0);
    expect(p.timers).toEqual([]);
    expect(await p.sent()).toEqual([]);
  });
});
