// The public pages' own analytics (src/core/analytics.ts): events queue here and go to POST
// call/e in batches, by beacon, when the page is hidden or closed, when a few have queued, or
// after a short while. Nothing is sent unless the server turned it on (<body data-analytics="1">,
// config/analytics.yaml), so the recorder's page (listen/render) sends nothing. No cookies: a
// random visit id per tab (sessionStorage) and one per page load.

type Props = Record<string, string | number | boolean | null>;
interface Ev {
  type: "view" | "click" | "play" | "pause" | "ended" | "watch";
  t: number;
  path: string;
  demo?: string;
  props: Props;
}

const VISIT_KEY = "ss-visit";
/** flush once this many have queued */
const BATCH = 8;
/** or this long after the first */
const WAIT_MS = 10_000;
/** the server takes at most 50 a request */
const MAX_PER_REQUEST = 50;

/** 16 URL-safe random characters */
function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

let endpoint: string | null = null;
let visit = "";
const load = randomId();
const queue: Ev[] = [];
const beforeHide: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** Starts tracking if the page allows it: the view, link and [data-track] clicks, flushing on hide. */
export function startTracking(base: string): boolean {
  if (endpoint || document.body.dataset.analytics !== "1") return false;
  endpoint = `${base}call/e`;
  try {
    visit = sessionStorage.getItem(VISIT_KEY) ?? "";
    if (!/^[A-Za-z0-9_-]{16}$/.test(visit)) sessionStorage.setItem(VISIT_KEY, (visit = randomId()));
  } catch {
    visit = randomId();
  }
  const q = new URLSearchParams(location.search);
  const nav = navigator as Navigator & { connection?: { effectiveType?: string }; userAgentData?: { platform?: string } };
  const view: Props = {
    referrer: document.referrer || null,
    vw: innerWidth,
    vh: innerHeight,
    sw: screen.width,
    sh: screen.height,
    dpr: devicePixelRatio,
    lang: navigator.language || null,
    langs: navigator.languages?.join(",") || null,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    platform: nav.userAgentData?.platform || navigator.platform || null,
    touch: navigator.maxTouchPoints > 0,
    net: nav.connection?.effectiveType ?? null,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
  };
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"]) {
    const v = q.get(k);
    if (v) view[k] = v;
  }
  track("view", view);
  // Capturing, so a handler that stops the click doesn't hide it.
  document.addEventListener("click", onClick, true);
  const hide = () => {
    for (const f of beforeHide) f();
    flush();
  };
  addEventListener("pagehide", hide);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && hide());
  return true;
}

/** Queues an event; a no-op until startTracking. */
export function track(type: Ev["type"], props: Props = {}, demo?: string) {
  if (!endpoint) return;
  queue.push({ type, t: Date.now(), path: location.pathname, ...(demo ? { demo } : {}), props });
  if (queue.length >= BATCH) flush();
  else timer ??= setTimeout(flush, WAIT_MS);
}

/** `f` runs just before the page is hidden or closed (and its queue flushed): for final totals. */
export function onHide(f: () => void) {
  beforeHide.push(f);
}

/** Links, and anything marked data-track="<action>" (data-track-target: what), unless data-notrack. */
function onClick(e: MouseEvent) {
  const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-track], a[href]");
  if (!el || el.hasAttribute("data-notrack")) return;
  const a = el instanceof HTMLAnchorElement ? el : null;
  // this site's links by path, others in full (tel:, GitHub)
  const href = a ? (a.origin === location.origin ? a.pathname + a.search : a.href) : null;
  track("click", { action: el.dataset.track || "link", target: el.dataset.trackTarget ?? href });
}

function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (!endpoint || !queue.length) return;
  while (queue.length) {
    const body = JSON.stringify({ visit, load, now: Date.now(), events: queue.splice(0, MAX_PER_REQUEST) });
    // text/plain: a beacon with it needs no preflight anywhere
    let sent = false;
    try {
      sent = navigator.sendBeacon?.(endpoint, new Blob([body], { type: "text/plain" })) ?? false;
    } catch {}
    if (!sent) void fetch(endpoint, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
  }
}

export type Span = [number, number];

/** an audio element's played ranges */
export function spansOf(r: TimeRanges): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)]);
  return out;
}

/** overlapping or touching spans joined, in order */
export function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** seconds covered (spans merged first, so nothing counts twice) */
export const spanSeconds = (spans: Span[]) => mergeSpans(spans).reduce((n, [a, b]) => n + (b - a), 0);
