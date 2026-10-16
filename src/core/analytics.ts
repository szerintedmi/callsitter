import { z } from "zod";

// The public site's first-party page analytics (config/analytics.yaml): the pages queue events
// (src/web/client/track.ts) and beacon them in batches to POST call/e (src/web/analytics.tsx),
// which checks them here and stores them; the admin UI's /analytics sums them up. No cookies: a
// random visit id per browser tab (sessionStorage) and one per page load. Each event keeps the
// visitor's IP, user agent (and what's parsed from it), Accept-Language and Cloudflare's location.
//
// Listening time: a `watch` event carries a recording's running totals for the page load (the
// seconds heard, without counting a part heard twice, the furthest point, and whether 90% of it
// was heard). The page sends it again as the totals grow, so the latest (largest) per (visit,
// page load, recording) counts; a visit's loads (a reload in the same tab) add up.

export const PAGE_EVENT_TYPES = ["view", "click", "play", "pause", "ended", "watch"] as const;
export type PageEventType = (typeof PAGE_EVENT_TYPES)[number];

export type PropValue = string | number | boolean | null;

/** A stored page event. */
export interface PageEventRecord {
  visitId: string;
  loadId: string;
  /** server time, ms */
  at: number;
  type: PageEventType;
  path: string | null;
  /** a recording's slug (src/web/listen.ts DEMOS) */
  demo: string | null;
  props: Record<string, PropValue>;
  /** Cloudflare's CF-Connecting-IP */
  ip: string | null;
  /** cut to MAX_STRING */
  userAgent: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  device: Device | null;
  mobile: boolean | null;
  acceptLanguage: string | null;
  /** Cloudflare's CF-IPCountry, CF-IPCity, CF-Region (the last two only with its location headers on) */
  country: string | null;
  city: string | null;
  region: string | null;
}

/** most events in one request */
export const MAX_EVENTS = 50;
/** longest string kept (referrers, link targets); longer ones are cut */
export const MAX_STRING = 300;
const MAX_PROPS = 32;
/** how far back the page may date an event: it queues them until it flushes */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const id = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const str = z.string().transform((s) => s.slice(0, MAX_STRING));
const Event = z.object({
  type: z.enum(PAGE_EVENT_TYPES),
  /** the page's clock when it happened */
  t: z.number().finite(),
  path: str.optional(),
  demo: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  props: z
    .record(z.string().regex(/^[A-Za-z0-9_]{1,32}$/), z.union([str, z.number().finite(), z.boolean(), z.null()]))
    .refine((p) => Object.keys(p).length <= MAX_PROPS, `at most ${MAX_PROPS} props`)
    .default({}),
});
/** POST call/e's body. `now`: the page's clock as it sent it (event times are taken relative to it). */
export const Beacon = z.object({
  visit: id,
  load: id,
  now: z.number().finite(),
  events: z.array(Event).min(1).max(MAX_EVENTS),
});

export interface BeaconContext {
  /** server time */
  now: number;
  ip?: string;
  userAgent?: string;
  acceptLanguage?: string;
  country?: string;
  city?: string;
  region?: string;
  /** the page's host: a referrer from it isn't one */
  host?: string;
  /** the recordings' slugs; another `demo` is dropped */
  demos: readonly string[];
}

/** Checks a beacon and turns it into rows, or says what's wrong with it. */
export function parseBeacon(raw: unknown, ctx: BeaconContext): { rows: PageEventRecord[] } | { error: string } {
  const res = Beacon.safeParse(raw);
  if (!res.success) return { error: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const b = res.data;
  const ua = parseUserAgent(ctx.userAgent ?? "");
  const country = ctx.country && /^[A-Z0-9]{2}$/i.test(ctx.country) ? ctx.country.toUpperCase() : null;
  const cut = (v: string | undefined) => (v ? v.slice(0, MAX_STRING) : null);
  const rows = b.events.map((e): PageEventRecord => {
    const props = { ...e.props };
    if (e.type === "view") Object.assign(props, sourceOf(props, ctx.host));
    return {
      visitId: b.visit,
      loadId: b.load,
      // The page's clock may be off; the time since the event isn't.
      at: ctx.now - Math.min(MAX_AGE_MS, Math.max(0, b.now - e.t)),
      type: e.type,
      path: e.path?.startsWith("/") ? e.path : null,
      demo: e.demo && ctx.demos.includes(e.demo) ? e.demo : null,
      props,
      ip: cut(ctx.ip),
      userAgent: cut(ctx.userAgent),
      ...ua,
      acceptLanguage: cut(ctx.acceptLanguage),
      country,
      city: cut(ctx.city),
      region: cut(ctx.region),
    };
  });
  return { rows };
}

/** A view's referrer host (not this site's) and where the visit came from: utm_source, ?ref=, or the referrer's host. */
function sourceOf(p: Record<string, PropValue>, host?: string): { refHost?: string; source?: string } {
  let refHost: string | undefined;
  if (typeof p.referrer === "string" && URL.canParse(p.referrer)) {
    const h = new URL(p.referrer).hostname.toLowerCase().replace(/^www\./, "");
    if (h && h !== host?.toLowerCase().replace(/^www\./, "")) refHost = h;
  }
  const tag = [p.utm_source, p.ref].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const source = tag?.trim().toLowerCase() ?? refHost;
  return { ...(refHost ? { refHost } : {}), ...(source ? { source } : {}) };
}

const BOT = /bot\b|bot\/|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|undici|httpclient|libwww|phantom|puppeteer|playwright|selenium|monitor|uptime|pingdom/i;

/** Crawlers, link previews, scripts and empty user agents: not counted. */
export const isBot = (userAgent: string | undefined) => !userAgent || userAgent.length < 20 || BOT.test(userAgent);

export type Device = "mobile" | "tablet" | "desktop";

export interface UserAgentInfo {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  device: Device | null;
  /** a phone or tablet */
  mobile: boolean | null;
}

/** first match's version group, dots for underscores (iOS "17_4" is 17.4) */
const ver = (ua: string, re: RegExp) => re.exec(ua)?.[1]?.replace(/_/g, ".") ?? null;

/** The browser, OS and device type from a user agent: the common ones, by hand. */
export function parseUserAgent(ua: string): UserAgentInfo {
  if (!ua) return { browser: null, browserVersion: null, os: null, osVersion: null, device: null, mobile: null };
  // Order matters: Edge, Opera and Samsung say Chrome too, and Chrome says Safari.
  const browsers: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
    ["Samsung", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari\//],
  ];
  const b = browsers.find(([, re]) => re.test(ua));
  const browser = b?.[0] ?? (/Safari\//.test(ua) ? "Safari" : "other");
  const browserVersion = b ? ver(ua, b[1]) : null;

  const [os, osVersion]: [string | null, string | null] = /iPhone|iPad|iPod/.test(ua)
    ? ["iOS", ver(ua, /OS (\d+(?:_\d+)*)/)]
    : /Android/.test(ua)
      ? ["Android", ver(ua, /Android (\d+(?:\.\d+)*)/)]
      : /Windows NT/.test(ua)
        ? ["Windows", ver(ua, /Windows NT ([\d.]+)/)]
        : /CrOS/.test(ua)
          ? ["ChromeOS", null]
          : /Mac OS X/.test(ua)
            ? ["macOS", ver(ua, /Mac OS X (\d+(?:[_.]\d+)*)/)]
            : /Linux/.test(ua)
              ? ["Linux", null]
              : [null, null];

  const device: Device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet" : /Mobi|iPhone|iPod/.test(ua) ? "mobile" : "desktop";
  return { browser, browserVersion, os, osVersion, device, mobile: device !== "desktop" };
}

/** Requests per key over a sliding minute, in memory (a restart resets it). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute: () => number) {}

  /** counts a request; false: over the limit */
  allow(key: string, now: number): boolean {
    const from = now - 60_000;
    // Keys that have gone quiet are dropped now and then, so the map doesn't grow.
    if (this.hits.size > 10_000) for (const [k, ts] of this.hits) if (ts.at(-1)! <= from) this.hits.delete(k);
    const recent = (this.hits.get(key) ?? []).filter((t) => t > from);
    const ok = recent.length < this.perMinute();
    if (ok) recent.push(now);
    this.hits.set(key, recent);
    return ok;
  }
}

/** One visit's listening to one recording: its page loads added up. */
export interface Listen {
  visitId: string;
  demo: string;
  seconds: number;
  completed: boolean;
}

export interface DemoStats {
  demo: string;
  /** plays from the start (position under a second): a first play, or again after the end */
  plays: number;
  /** visits that heard at least a second of it */
  listeners: number;
  avgSeconds: number;
  medianSeconds: number;
  /** of the listeners, those who heard 90% of it */
  completionRate: number;
}

export interface Count {
  name: string;
  n: number;
}

export interface AnalyticsSummary {
  visits: number;
  views: number;
  /** visits that heard at least a second of a recording */
  listeningVisits: number;
  listenSeconds: number;
  demos: DemoStats[];
  clicks: { action: string; target: string; n: number }[];
  /** visits by where they came from: their first view's source, referrer host, country, device, browser, OS */
  sources: Count[];
  referrers: Count[];
  countries: Count[];
  devices: Count[];
  browsers: Count[];
  oses: Count[];
  /** UTC days, oldest first */
  days: { day: string; visits: number; views: number; listeners: number }[];
}

export interface VisitSummary {
  visitId: string;
  firstAt: number;
  lastAt: number;
  source: string | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  mobile: boolean | null;
  browser: string | null;
  os: string | null;
  views: number;
  clicks: number;
  listened: { demo: string; seconds: number }[];
}

/** The recordings' stats from each visit's listening and the plays from the start per recording. */
export function demoStats(listens: Listen[], plays: Map<string, number>, order: readonly string[]): DemoStats[] {
  const demos = [...new Set([...order, ...plays.keys(), ...listens.map((l) => l.demo)])];
  return demos.map((demo) => {
    const heard = listens.filter((l) => l.demo === demo && l.seconds >= 1);
    const secs = heard.map((l) => l.seconds);
    return {
      demo,
      plays: plays.get(demo) ?? 0,
      listeners: heard.length,
      avgSeconds: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : 0,
      medianSeconds: median(secs),
      completionRate: heard.length ? heard.filter((l) => l.completed).length / heard.length : 0,
    };
  });
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
