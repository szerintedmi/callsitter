import { Hono } from "hono";
import { raw } from "hono/html";
import type { UpgradeWebSocket } from "hono/ws";
import type { FC, PropsWithChildren } from "hono/jsx";
import { describeCosts, describeLunaTokens } from "../core/cost";
import { CHANNELS, type Channel } from "../core/limits";
import type { BlobStore, CallFilter, CallRecord, EventBus, Repo } from "../core/ports";
import type { Verdict as VerdictName } from "../core/types";
import type { LogBuffer } from "./debug-log";
import { favicon } from "./favicon";

/** The call list's cost tooltip: by vendor, with Luna's tokens; calls from before only have the estimate. */
function costTitle(r: CallRecord): string | undefined {
  const c = r.costs;
  if (!c) return r.costUsd != null ? "estimate" : undefined;
  return `${describeCosts(c)}; Luna ${c.luna.calls} requests, ${describeLunaTokens(c.luna)}; Jev ${c.jevInputTokens} input tokens; Live ${c.liveSeconds} s`;
}

/** Compiled browser script by file name ("test-call.js"), or undefined; see src/runtime/client-assets.ts. */
export type ClientAssets = (name: string) => Promise<string | undefined>;

export interface AdminDeps {
  repo: Repo;
  blobs: BlobStore;
  bus: EventBus;
  upgradeWebSocket: UpgradeWebSocket;
  /** recent server log lines for the test-call debug panel */
  debugLog?: LogBuffer;
  /** the page scripts (src/web/client), served under /assets/ */
  clientAssets: ClientAssets;
  /** why no call can be taken over (CallManager.takeoverOff), or null; absent: no Take over button */
  takeoverOff?: () => string | null;
}

/** Taken over: the latest takeover event is a start (takeover.failed means the agent carried on). */
const takenOver = (events: readonly { type: string }[]) =>
  events.findLast((e) => e.type === "takeover.started" || e.type === "takeover.failed")?.type === "takeover.started";

const css = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e3e3e3;--scam:#c0392b;--spam:#b9770e;--genuine:#1e8449;--card:#f3f3f3;--agent:#2f6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2e2e2e;--card:#222;--agent:#6d9cf2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}a{color:inherit}h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:20px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:13px}
.tag{display:inline-block;padding:1px 7px;border-radius:9px;font-size:12px;border:1px solid var(--line)}.scam{color:var(--scam)}.spam{color:var(--spam)}.genuine{color:var(--genuine)}.unclear{color:var(--muted)}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:3fr 2fr;gap:20px}@media (max-width:800px){.grid{grid-template-columns:1fr}}
.wrap{overflow-x:auto}audio{width:100%}
nav{display:flex;gap:14px;align-items:baseline;margin-bottom:12px}nav h1{margin:0;flex:1}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--genuine);border-color:var(--genuine);color:#fff}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.meter{width:120px;height:8px;background:var(--line);border-radius:4px;overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--genuine);transition:width 80ms}
details.debug{margin:14px 0}details.debug summary{cursor:pointer;color:var(--muted);font-size:13px}details.debug summary a{margin-left:10px}
.debuglog{max-height:320px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
.dl.warn{color:var(--spam)}.dl.error{color:var(--scam)}
table.sip{font:12px/1.4 ui-monospace,monospace}table.sip th{white-space:nowrap;color:var(--muted);font-weight:500;width:1%}table.sip td{word-break:break-all}
/* timeline (src/web/client/timeline.ts): a gutter of five lanes (caller, Live, call flow, Jev, Luna) + the event */
.state{padding:8px 12px;background:var(--card);border-radius:8px;margin:12px 0;position:sticky;top:0;z-index:3;font-size:14px}
.state .row{display:flex;flex-wrap:wrap;gap:4px 18px}.state .row+.row{border-top:1px solid var(--line);margin-top:6px;padding-top:6px}
.state .row div{display:flex;gap:6px;align-items:center}.state label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.tl-head,.ev{display:grid;grid-template-columns:56px 90px minmax(0,1fr)}
.state .tl-head{margin:6px -12px -4px;border-top:1px solid var(--line);padding-top:4px}
.tl-head .g{position:relative;height:16px;font-size:10px;color:var(--muted);text-transform:uppercase}.tl-head .g span{position:absolute;transform:translateX(-50%);cursor:help}
.ev{--y:12px}.ev.tx{--y:20px}.ev.stage{--y:14px}.ev.end,.ev.summary{--y:17px}.ev .g{position:relative}.ev .b{padding:3px 0 3px 6px;font-size:13px;min-width:0;overflow-wrap:anywhere}
.ev .tm{padding:calc(var(--y) - 8px) 8px 0 0;line-height:16px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}
.ln{position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:var(--line)}
.ln.f:not(.run){background:repeating-linear-gradient(var(--muted) 0 3px,transparent 3px 7px);opacity:.6}
.ln.c{left:9px}.ln.l{left:27px}.ln.f{left:45px}.ln.j{left:63px}.ln.u{left:81px}
.ln.staged{width:3px;margin-left:-1.5px;background:var(--stage)}.ln.run{width:3px;margin-left:-1.5px;background:var(--genuine);opacity:.6}
.ln.f.run{background:var(--muted);opacity:.7}.ln.f.hold{width:4px;margin-left:-2px;background:repeating-linear-gradient(var(--fg) 0 5px,transparent 5px 9px);opacity:.9}
.ln.above{bottom:auto;height:var(--y)}.ln.below{top:var(--y)}
.dot{position:absolute;top:var(--y);width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:var(--muted);z-index:1;box-shadow:0 0 0 2px var(--bg)}
.dot.flow{width:5px;height:5px;margin:-2.5px 0 0 -2.5px;background:var(--fg)}
.dot.tick{width:5px;height:5px;margin:-2.5px 0 0 -2.5px;background:var(--bg);border:1.5px solid var(--muted)}
.dot.caller{background:var(--fg)}.dot.agent{background:var(--agent)}.dot.j{width:5px;height:5px;margin:-2.5px 0 0 -2.5px}
.dot.hit,.dot.hollow{width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:1px;transform:rotate(45deg);background:var(--fg)}
.dot.hollow{background:var(--bg);border:1.5px solid var(--muted)}
.dot.luna{background:var(--genuine)}.dot.small{width:5px;height:5px;margin:-2.5px 0 0 -2.5px;background:var(--genuine)}
.dot.in{background:var(--bg);border:2px solid var(--stage,var(--agent))}
.dot.stage{width:11px;height:11px;margin:-5.5px 0 0 -5.5px;background:var(--stage)}
.arr{position:absolute;top:var(--y);height:0;margin-top:-.75px;border-top:1.5px solid var(--muted)}.arr.luna{border-color:var(--genuine)}
.arr::after{content:"";position:absolute;top:-4.75px;border:4px solid transparent}
.arr.right::after{right:3px;border-right:0;border-left:6px solid;border-left-color:inherit}.arr.left::after{left:3px;border-left:0;border-right:6px solid;border-right-color:inherit}
.arr.right::after{border-left-color:var(--muted)}.arr.left::after{border-right-color:var(--muted)}
.arr.luna.right::after{border-left-color:var(--genuine)}.arr.luna.left::after{border-right-color:var(--genuine)}
.utt{display:inline-block;max-width:92%;font-size:15px;padding:7px 13px;border-radius:12px;background:var(--card)}
.who{width:11px;height:11px;margin-right:6px;vertical-align:-1px;fill:currentColor;opacity:.35}
.utt.agent{background:color-mix(in srgb,var(--agent) 13%,var(--bg))}.utt.partial{opacity:.6}
.ev.jev.quiet .b{font-size:12px;color:var(--muted)}.ev.jev.quiet .tag{font-size:11px;padding:0 6px}
.ev.jev .out{font-weight:600}.ev.jev.skip .out{font-weight:500;color:var(--muted)}
.xa{display:block;color:var(--muted);font-size:12px;font-weight:400}.xa i{font-style:normal;white-space:nowrap}
.ev .line{display:flex;gap:6px;align-items:baseline;white-space:nowrap;min-width:0}.ev .line .txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ev .txt.struck,.ev.dropped .txt{text-decoration:line-through;opacity:.65}
.ev.append .b,.ev.luna .b,.ev.tool .b,.ev.progress .b{font-size:13px}.ev.tool .b,.ev.progress .b{color:var(--muted)}
.ev.append.owner .b b{color:var(--agent)}
.ou{white-space:nowrap}.ou.due{font-weight:600;color:var(--agent)}
.ev.stage .b{font-size:12px;padding-top:5px;padding-bottom:5px}.ev.stage .b b{color:var(--stage);font-weight:600}
.ev.note .b{font-size:12px;color:var(--muted)}.ev.note.warn .b{color:var(--spam)}.ev.note.error .b{color:var(--scam)}
.ev.end .b,.ev.summary .b{padding-top:8px}
.ev.takeover .b{font-size:13px}.ev.takeover b{color:var(--agent)}
.ev.takeover.live{--y:17px}.ev.takeover.live .b{margin-top:8px;padding:5px 8px;border-top:1px dashed var(--agent);color:var(--agent);font-size:13px;font-weight:600}.ev.takeover.live .b .muted{font-weight:400}
.tag.owner,.tag.by-owner{color:var(--agent);border-color:var(--agent)}
/* stage colour: .st turns --h (the stage's hue) into --stage */
.st{--stage:hsl(var(--h) 42% 48%)}@media (prefers-color-scheme:dark){.st{--stage:hsl(var(--h) 45% 62%)}}
.sdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--stage,var(--line));margin-right:6px;vertical-align:middle}
.bar{display:inline-block;width:44px;height:6px;background:var(--line);border-radius:3px;vertical-align:middle;overflow:hidden}
.bar i{display:block;height:100%;background:var(--muted)}.bar.scam i{background:var(--scam)}.bar.spam i{background:var(--spam)}.bar.genuine i{background:var(--genuine)}
.tag.live{color:var(--genuine);border-color:var(--genuine)}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}.filters>span{width:64px;font-size:13px}.filters a{text-decoration:none}.filters a.on{background:var(--card);border-color:currentColor;font-weight:600}
.tag.ch-public{color:var(--agent)}
.ended{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tag.by-live,.tag.by-system{color:var(--spam)}
.ev.has-tip .g{cursor:help}
/* analytics (src/web/analytics.tsx) */
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 8px}.stats div{background:var(--card);border-radius:8px;padding:8px 14px;min-width:140px}
.stats b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.stats span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 24px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.hbar{display:inline-block;height:8px;background:var(--agent);border-radius:2px;vertical-align:middle;margin-right:6px}
.mono{font:12px/1.4 ui-monospace,monospace}
.tip{position:fixed;z-index:10;display:none;max-width:min(520px,calc(100vw - 16px));max-height:70vh;overflow:hidden;padding:8px 10px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.3);font-size:12px;line-height:1.45;pointer-events:none;overflow-wrap:anywhere}
.tip.on{display:block}.tip h4{margin:0 0 4px;font-size:12px}.tip .pre{white-space:pre-wrap}.tip .sec{margin-top:6px;padding-top:6px;border-top:1px solid var(--line)}
.tip table{width:auto}.tip th,.tip td{padding:1px 10px 1px 0;border:0;font-size:12px}.tip th{color:var(--muted);font-weight:500}
.tip pre{margin:2px 0 0;white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;color:var(--muted)}
`;

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title}</title>
      <link rel="icon" type="image/svg+xml" href={favicon} />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <style>{raw(css)}</style>
    </head>
    <body>
      <main>{children}</main>
    </body>
  </html>
);

export const fmtTime = (ms: number) => new Date(ms).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" });
const fmtDur = (r: CallRecord) => {
  if (!r.endedAt) return r.status === "ended" ? "–" : "live";
  const s = Math.round((r.endedAt - r.startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** Who ended the call (calls from before it was recorded only have the reason) and why. */
const Ended: FC<{ r: CallRecord }> = ({ r }) => (
  <>
    {r.endedBy && (
      <span class={`tag by-${r.endedBy}`} title={r.endedBy === "owner" ? "the owner took the call over and hung up" : undefined}>
        {r.endedBy === "owner" ? "🎧 owner" : r.endedBy}
      </span>
    )}{" "}
    {r.endReason ?? ""}
  </>
);
const VERDICTS: readonly VerdictName[] = ["scam", "spam", "genuine", "unclear"];

/** The call list's filters from its query string; unknown values are ignored. */
function parseFilter(q: Record<string, string>): CallFilter {
  const pick = <T extends string>(v: string | undefined, all: readonly T[]) => all.find((x) => x === v);
  return { channel: pick(q.channel, CHANNELS), verdict: pick(q.verdict, VERDICTS) };
}

function filterHref(f: CallFilter): string {
  const q = new URLSearchParams();
  if (f.channel) q.set("channel", f.channel);
  if (f.verdict) q.set("verdict", f.verdict);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

/** One row of filter links: "all", then each value; the current one is marked. */
const FilterRow: FC<{ label: string; f: CallFilter; k: keyof CallFilter; values: readonly string[] }> = ({ label, f, k, values }) => (
  <div class="filters">
    <span class="muted">{label}</span>
    {[undefined, ...values].map((v) => (
      <a href={filterHref({ ...f, [k]: v })} class={`tag ${v ?? ""} ${f[k] === v ? "on" : ""}`}>
        {v ?? "all"}
      </a>
    ))}
  </div>
);

const Verdict: FC<{ v: string | null }> = ({ v }) => (v ? <span class={`tag ${v}`}>{v}</span> : <span class="muted">–</span>);

/** JSON for embedding in <script type="application/json">. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Live state strip (stats, then the classification) plus the call timeline (see client/timeline.ts). */
const Timeline: FC = () => (
  <div id="timeline">
    <div class="state">
      <div class="row">
        <div>
          <label>status</label>
          <span data-s="status">–</span>
        </div>
        <div>
          <label>elapsed</label>
          <span data-s="elapsed">–</span>
        </div>
        <div>
          <label>Jev ticks</label>
          <span data-s="jev">0</span>
        </div>
        <div>
          <label>Luna calls</label>
          <span data-s="luna">0</span>
        </div>
        <div>
          <label>Live context</label>
          <span data-s="ctx">–</span>
        </div>
        <div>
          <label>cost</label>
          <span data-s="cost">–</span>
        </div>
      </div>
      <div class="row">
        <div>
          <label>verdict</label>
          <span data-s="verdict">–</span>
        </div>
        <div>
          <label>urgency</label>
          <span data-s="urgency">–</span>
        </div>
        <div>
          <label>stage</label>
          <span data-s="stage">–</span>
        </div>
        <div>
          <label>owner update</label>
          <span data-s="owner" title="Jev: has the caller said something new for the owner since the last summary? (luna.yaml progress.when)">–</span>
        </div>
      </div>
      <div class="tl-head">
        <div />
        <div class="g">
          <span style="left:9px" title="caller">C</span>
          <span style="left:27px" title="Live (the voice agent)">L</span>
          <span style="left:45px" title="call flow (server: rules, holding texts, hang-up)">F</span>
          <span style="left:63px" title="Jev (classifier)">J</span>
          <span style="left:81px" title="Luna (supervisor)">Lu</span>
        </div>
        <div />
      </div>
    </div>
    <div data-rows id="rows" />
  </div>
);

/** Changes on every server start, so the pages never run a stale cached script. */
const BUILD = Date.now().toString(36);

const js = (body: string) => new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });

export function adminRoutes(d: AdminDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const f = parseFilter(c.req.query());
    const calls = await d.repo.listCalls(200, f);
    return c.html(
      <Layout title="CallSitter">
        <nav>
          <h1>Calls</h1>
          <a href="/analytics">Page analytics</a>
          <a href="/test-call">Test call from this computer →</a>
        </nav>
        <FilterRow label="Channel" f={f} k="channel" values={CHANNELS} />
        <FilterRow label="Verdict" f={f} k="verdict" values={VERDICTS} />
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Channel</th>
                <th>From</th>
                <th>Verdict</th>
                <th>Stage</th>
                <th>Luna</th>
                <th>Duration</th>
                <th>Cost</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((r) => (
                <tr>
                  <td>
                    <a href={`/calls/${r.id}`}>{fmtTime(r.startedAt)}</a>
                  </td>
                  <td>
                    <span class={`tag ch-${r.channel}`}>{r.channel}</span>
                  </td>
                  <td>
                    {r.from || "unknown"}
                    {r.divertedFrom && <span class="muted"> via {r.divertedFrom}</span>}
                    {r.callerIp && <span class="muted"> {r.callerIp}</span>}
                  </td>
                  <td>
                    <Verdict v={r.verdict} />
                  </td>
                  <td>{r.stage ?? "–"}</td>
                  <td>{r.lunaCalls}</td>
                  <td>{fmtDur(r)}</td>
                  <td title={costTitle(r)}>{r.costUsd != null ? `$${r.costUsd.toFixed(3)}` : "–"}</td>
                  <td class="ended" title={r.endReason ?? undefined}>
                    {r.status === "ended" ? <Ended r={r} /> : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {calls.length === 0 && <p class="muted">{f.channel || f.verdict ? "No calls match." : "No calls yet."}</p>}
        </div>
        <script src={`/assets/calls.js?v=${BUILD}`} />
      </Layout>,
    );
  });

  app.get("/calls/:id", async (c) => {
    const call = await d.repo.getCall(c.req.param("id"));
    if (!call) return c.notFound();
    const events = (await d.repo.listEvents(call.id)).map((e) => e.event);
    // The Telegram button's conditions (owner-desk.ts): a live phone call, takeover set up. Hidden
    // while taken over; call.ts hides and shows it on the live events.
    const takeover = call.channel === "phone" && call.status !== "ended" && d.takeoverOff?.() === null;
    return c.html(
      <Layout title={`Call ${call.from || call.id}`}>
        <div data-call={call.id}>
          <p>
            <a href="/">← Calls</a>
          </p>
          <h1>
            {call.from || "Unknown caller"} <Verdict v={call.verdict} />
          </h1>
          <p class="muted">
            {fmtTime(call.startedAt)}
            {call.callerIp && ` · IP ${call.callerIp}`}
          </p>
          {call.status === "ended" && (
            <p>
              <span class="muted">Ended:</span> <Ended r={call} />
            </p>
          )}
          {takeover && (
            <p>
              <button id="takeover" class="primary" data-href={`/calls/${encodeURIComponent(call.id)}/takeover`} hidden={takenOver(events)} title="Talk to the caller yourself (opens a new tab)">
                🎧 Take over
              </button>
            </p>
          )}
          {call.summary && <p>{call.summary}</p>}
          {call.recordingPath && <audio controls preload="none" src={`/recordings/${call.id}`} />}
          <div id="callinfo" />
          <Timeline />
        </div>
        <script id="initial" type="application/json">
          {raw(safeJson(events))}
        </script>
        <script src={`/assets/call.js?v=${BUILD}`} />
      </Layout>,
    );
  });

  // The call info so far: SIP headers and carrier metadata (the test-call page subscribes too late to see them).
  app.get("/calls/:id/call-info", async (c) => {
    const events = (await d.repo.listEvents(c.req.param("id"))).map((e) => e.event);
    return c.json(events.filter((e) => e.type === "sip.headers" || e.type === "carrier.hangup"));
  });

  app.get("/assets/:name", async (c) => {
    const body = await d.clientAssets(c.req.param("name"));
    return body === undefined ? c.notFound() : js(body);
  });

  app.get("/test-call", (c) =>
    c.html(
      <Layout title="Test call">
        <p>
          <a href="/">← Calls</a>
        </p>
        <h1>Test call from this computer</h1>
        <div class="controls">
          <button id="start" class="primary">
            Start call
          </button>
          <button id="hangup" disabled>
            Hang up
          </button>
          <label>
            Route{" "}
            <select id="route">
              <option value="ws">Direct (WebSocket)</option>
              <option value="sip">SIP (Telnyx WebRTC → OpenAI SIP)</option>
            </select>
          </label>
          <label>
            <input type="checkbox" id="dry" /> Dry-run Luna tools (no Telegram from Luna, no hang-up)
          </label>
          <span class="meter" title="microphone level">
            <i id="meter" />
          </span>
          <span id="status" class="muted">
            idle
          </span>
          <span id="calllink" />
        </div>
        <audio id="remote" autoplay />
        <div id="callinfo" />
        <details class="debug">
          <summary>
            Debug log<span id="debugcount" /> <a href="#" id="debugclear">clear</a>
          </summary>
          <div class="debuglog" id="debuglog" />
        </details>
        <Timeline />
        <script src={`/assets/test-call.js?v=${BUILD}`} />
      </Layout>,
    ),
  );

  // ?after=<seq>: server log lines since then. &tail=0 returns only the latest seq (page load).
  app.get("/debug/log", (c) => {
    const log = d.debugLog;
    if (!log) return c.json({ lines: [], last: 0 });
    if (c.req.query("tail") === "0") return c.json({ lines: [], last: log.last });
    return c.json({ lines: log.after(Number(c.req.query("after") ?? 0) || 0), last: log.last });
  });

  app.get("/recordings/:id", async (c) => {
    const call = await d.repo.getCall(c.req.param("id"));
    if (!call?.recordingPath) return c.notFound();
    const blob = await d.blobs.get(call.recordingPath);
    if (!blob) return c.notFound();
    return new Response(blob.body, { headers: { "Content-Type": blob.contentType || "audio/mpeg" } });
  });

  app.get(
    "/ws",
    d.upgradeWebSocket((c) => {
      const callId = c.req.query("callId");
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen(_evt, ws) {
          unsubscribe = d.bus.subscribe((ev) => {
            if (callId && ev.callId !== callId) return;
            // The list page only needs lifecycle events.
            if (!callId && ev.type !== "call.started" && ev.type !== "call.ended" && ev.type !== "summary") return;
            ws.send(JSON.stringify(ev));
          });
        },
        onClose() {
          unsubscribe?.();
        },
      };
    }),
  );

  return app;
}
