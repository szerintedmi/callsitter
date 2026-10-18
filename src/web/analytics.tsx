import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FC } from "hono/jsx";
import { isBot, parseBeacon, RateLimiter, type Count, type PageEventRecord } from "../core/analytics";
import type { AppConfig } from "../core/config";
import { ipKey } from "../core/ip";
import { logger } from "../core/log";
import type { Repo } from "../core/ports";
import { fmtTime, Layout } from "./admin";
import { hostOf } from "./admin-guard";
import { DEMOS } from "./listen";

// The public site's page analytics (src/core/analytics.ts, config/analytics.yaml).
//
//   POST call/e                  the pages' event batches (src/web/client/track.ts), on the public
//                                host: under call/ because the tunnel routes that there, and same-origin
//                                only like the rest of call/ (public.ts). The admin preview's own
//                                visits aren't counted (app.ts).
//   GET  analytics?range=7d      admin: the dashboard (24h, 7d, 30d)
//   GET  analytics/visits/:id    admin: one visit's events

const log = logger("analytics");

/** a batch of 50 events is a few KB */
const MAX_BODY_BYTES = 16 * 1024;

export interface AnalyticsDeps {
  repo: Repo;
  config: () => AppConfig;
}

/** POST call/e. Always 204 for what isn't stored on purpose (off, bots), so a page never retries. */
export function analyticsRoutes(d: AnalyticsDeps) {
  const app = new Hono();
  const limiter = new RateLimiter(() => d.config().analytics.requests_per_ip_per_minute);
  app.post("/call/e", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.text("too large", 413) }), async (c) => {
    if (!d.config().analytics.enabled) return c.body(null, 204);
    const userAgent = c.req.header("user-agent");
    if (isBot(userAgent)) return c.body(null, 204);
    const ip = c.req.header("cf-connecting-ip");
    if (!limiter.allow(ipKey(ip ?? "local", d.config().limits.ipv6_prefix), Date.now())) return c.text("slow down", 429);
    // sendBeacon posts text/plain: the body is read as JSON whatever its type.
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.text("bad json", 400);
    }
    const parsed = parseBeacon(raw, {
      now: Date.now(),
      ip,
      userAgent,
      acceptLanguage: c.req.header("accept-language"),
      country: c.req.header("cf-ipcountry"),
      city: c.req.header("cf-ipcity"),
      region: c.req.header("cf-region"),
      host: hostOf(c.req.header("host")) ?? undefined,
      demos: DEMOS.map((x) => x.slug),
    });
    if ("error" in parsed) return c.text(parsed.error, 400);
    try {
      await d.repo.addPageEvents(parsed.rows);
    } catch (err) {
      log.warn("page events not stored", { err });
      return c.text("not stored", 500);
    }
    return c.body(null, 204);
  });
  return app;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS } as const;
type Range = keyof typeof RANGES;
const rangeOf = (q: string | undefined): Range => (q && q in RANGES ? (q as Range) : "7d");

const titleOf = (slug: string) => DEMOS.find((x) => x.slug === slug)?.title ?? slug;
/** "4:05", "1:02:03" */
const dur = (seconds: number) => {
  const s = Math.round(seconds);
  const mmss = `${Math.floor(s / 60) % 60}:${String(s % 60).padStart(2, "0")}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss.padStart(5, "0")}` : mmss;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

const Bar: FC<{ n: number; max: number }> = ({ n, max }) => <i class="hbar" style={`width:${max ? Math.max(2, (n / max) * 120) : 0}px`} />;

/** A name → count table with bars, its top rows. */
const Counts: FC<{ title: string; rows: Count[]; unit?: string }> = ({ title, rows, unit = "visits" }) => {
  const max = Math.max(0, ...rows.map((r) => r.n));
  return (
    <div>
      <h2>{title}</h2>
      <table>
        <tbody>
          {rows.slice(0, 15).map((r) => (
            <tr>
              <td>{r.name}</td>
              <td class="n">
                <Bar n={r.n} max={max} />
                {r.n}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p class="muted">No {unit} yet.</p>}
    </div>
  );
};

/** An event's details for the visit page: its props, without the noise. */
function describe(e: PageEventRecord): string {
  const p = { ...e.props };
  if (e.type === "view") delete p.source;
  return Object.entries(p)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v * 10) / 10 : v}`)
    .join("  ");
}

export function analyticsAdminRoutes(d: AnalyticsDeps) {
  const app = new Hono();

  app.get("/analytics", async (c) => {
    const range = rangeOf(c.req.query("range"));
    const since = Date.now() - RANGES[range];
    const s = await d.repo.pageStats(since, DEMOS.map((x) => x.slug));
    const visits = await d.repo.pageVisits(since, 100);
    const dayMax = Math.max(0, ...s.days.map((x) => x.visits));
    return c.html(
      <Layout title="Page analytics">
        <p>
          <a href="/">← Calls</a>
        </p>
        <nav>
          <h1>Page analytics</h1>
          {!d.config().analytics.enabled && <span class="tag">off (analytics.yaml)</span>}
        </nav>
        <div class="filters">
          <span class="muted">Range</span>
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <a href={`/analytics?range=${r}`} class={`tag ${r === range ? "on" : ""}`}>
              {r}
            </a>
          ))}
        </div>
        <div class="stats">
          <div>
            <b>{s.visits}</b>
            <span>visits</span>
          </div>
          <div>
            <b>{s.views}</b>
            <span>page views</span>
          </div>
          <div>
            <b>{s.listeningVisits}</b>
            <span>visits that listened</span>
          </div>
          <div>
            <b>{dur(s.listenSeconds)}</b>
            <span>listened in all</span>
          </div>
        </div>

        <h2>Recordings</h2>
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>Recording</th>
                <th class="n" title="plays from the start">Plays</th>
                <th class="n" title="visits that heard at least a second">Listeners</th>
                <th class="n">Avg heard</th>
                <th class="n">Median heard</th>
                <th class="n" title="listeners who heard 90% of it">Completed</th>
              </tr>
            </thead>
            <tbody>
              {s.demos.map((x) => (
                <tr>
                  <td>{titleOf(x.demo)}</td>
                  <td class="n">{x.plays}</td>
                  <td class="n">{x.listeners}</td>
                  <td class="n">{dur(x.avgSeconds)}</td>
                  <td class="n">{dur(x.medianSeconds)}</td>
                  <td class="n">{x.listeners ? pct(x.completionRate) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="cols">
          <div>
            <h2>Clicks</h2>
            <table>
              <tbody>
                {s.clicks.map((x) => (
                  <tr>
                    <td>{x.action}</td>
                    <td class="mono">{x.target}</td>
                    <td class="n">{x.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.clicks.length === 0 && <p class="muted">No clicks yet.</p>}
          </div>
          <Counts title="Sources (utm_source, ?ref=, referrer)" rows={s.sources} />
          <Counts title="Referrers" rows={s.referrers} />
          <Counts title="Countries" rows={s.countries} />
          <Counts title="Devices" rows={s.devices} />
          <Counts title="Browsers" rows={s.browsers} />
          <Counts title="OS" rows={s.oses} />
          <div>
            <h2>Per day (UTC)</h2>
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th class="n">Visits</th>
                  <th class="n">Views</th>
                  <th class="n">Listened</th>
                </tr>
              </thead>
              <tbody>
                {s.days.map((x) => (
                  <tr>
                    <td>{x.day}</td>
                    <td class="n">
                      <Bar n={x.visits} max={dayMax} />
                      {x.visits}
                    </td>
                    <td class="n">{x.views}</td>
                    <td class="n">{x.listeners}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <h2>Recent visits</h2>
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>Visit</th>
                <th>First seen</th>
                <th>Source</th>
                <th>IP</th>
                <th>Location</th>
                <th>Device</th>
                <th>Listened</th>
                <th class="n">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr>
                  <td class="mono">
                    <a href={`/analytics/visits/${encodeURIComponent(v.visitId)}`}>{v.visitId.slice(0, 8)}</a>
                  </td>
                  <td>{fmtTime(v.firstAt)}</td>
                  <td>{v.source ?? <span class="muted">direct</span>}</td>
                  <td class="mono">{v.ip ?? "–"}</td>
                  <td>{[v.city, v.country].filter(Boolean).join(", ") || "–"}</td>
                  <td>
                    {v.mobile === null ? "–" : v.mobile ? "mobile" : "desktop"}
                    {(v.browser || v.os) && <span class="muted"> {[v.browser, v.os].filter(Boolean).join(" / ")}</span>}
                  </td>
                  <td>{v.listened.map((l) => `${titleOf(l.demo)} ${dur(l.seconds)}`).join(", ") || <span class="muted">–</span>}</td>
                  <td class="n">{v.clicks}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visits.length === 0 && <p class="muted">No visits yet.</p>}
        </div>
      </Layout>,
    );
  });

  app.get("/analytics/visits/:id", async (c) => {
    const id = c.req.param("id");
    const events = await d.repo.pageVisit(id);
    if (!events.length) return c.notFound();
    const first = events[0]!;
    return c.html(
      <Layout title={`Visit ${id.slice(0, 8)}`}>
        <p>
          <a href="/analytics">← Page analytics</a>
        </p>
        <h1 class="mono">Visit {id}</h1>
        <p class="muted">
          {fmtTime(first.at)} · <span class="mono">{first.ip ?? "no IP"}</span> · {[first.city, first.region, first.country].filter(Boolean).join(", ") || "unknown location"} ·{" "}
          {first.device ?? "unknown device"} · {[first.browser, first.browserVersion].filter(Boolean).join(" ") || "unknown browser"} ·{" "}
          {[first.os, first.osVersion].filter(Boolean).join(" ") || "unknown OS"} · {new Set(events.map((e) => e.loadId)).size} page loads
        </p>
        {first.userAgent && <p class="mono muted">{first.userAgent}</p>}
        {first.acceptLanguage && <p class="muted">Accept-Language: {first.acceptLanguage}</p>}
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Page</th>
                <th>Recording</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr>
                  <td>{fmtTime(e.at)}</td>
                  <td>
                    <span class="tag">{e.type}</span>
                  </td>
                  <td class="mono">{e.path ?? ""}</td>
                  <td>{e.demo ? titleOf(e.demo) : ""}</td>
                  <td class="mono">{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Layout>,
    );
  });

  return app;
}
