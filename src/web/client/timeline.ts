// Call timeline: one chronological stream, with a narrow sequence-diagram gutter of five lanes
// (caller · Live · call flow · Jev · Luna). The call flow is the server: it runs Jev when the
// caller pauses, applies call-flow.yaml's rules to the answer, calls Luna, holds texts until the
// agent is idle and sends them to Live, and hangs up. Each row puts a dot in the lane of whoever
// acted; arrows show who sent what to whom (Jev → flow, flow → Live, flow → Luna, Luna → flow).
// Quiet Jev results (no rule changed anything) are a dot in Jev's lane only.
// A bar follows work under way: in Luna's lane while she runs (the summary too), in the flow's
// from a decision to its effect: a text reaching Live (bold dashed: held until the agent is
// idle), a Luna call starting, the hang-up. The Live lane takes the colour of the stage whose text it got last.
// The owner's Telegram steering reaches Live as its own rows ("owner → Live").
// Hovering a row shows its details: Jev's answers, Luna's task, reply, tool calls and what
// reached Live, and full texts sent to Live.

import { describeCosts, describeLunaTokens } from "../../core/cost";
import type { AppendSource, CallEvent, Classification, FlowDecision, PricedUsage, TranscriptEntry } from "../../core/types";

/** Stored events from calls recorded before the call flow. */
type LegacyEvent =
  | { type: "strategy"; callId: string; at: number; strategyId: string; as?: string }
  | {
      type: "classification";
      callId: string;
      at: number;
      classification: Omit<Classification, "answers"> & { answers?: Classification["answers"]; strategy?: string; category?: string };
      decision?: FlowDecision;
      ownerUpdate?: undefined;
    };

export type TimelineEvent = CallEvent | LegacyEvent;

export interface Timeline {
  on(ev: TimelineEvent): void;
  load(events: TimelineEvent[]): void;
  destroy(): void;
}

type Lane = "c" | "l" | "f" | "j" | "u";
/** Lane centres in the gutter (px): caller, Live, call flow, Jev, Luna. */
const X: Record<Lane, number> = { c: 9, l: 27, f: 45, j: 63, u: 81 };
/** Stage hues, in the order stages first appear in a call; neighbours contrast. */
const STAGE_HUES = [210, 30, 280, 150, 340, 60, 180, 250];

function esc(s: unknown) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
/** m:ss */
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
/** m:ss.t */
function fmt(ms: number) {
  return clock(ms) + "." + (Math.floor(Math.max(0, ms) / 100) % 10);
}
function pct(x: number) {
  return Math.round(Math.max(0, Math.min(1, x)) * 100);
}
function bar(x: number, cls?: string) {
  return '<span class="bar ' + (cls || "") + '"><i style="width:' + pct(x) + '%"></i></span>';
}
function secs(ms: number) {
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + " s";
}
/** Small speaker marks in the bubbles: a handset for the caller, a shield for our agent. */
const WHO: Record<string, string> = {
  caller:
    '<svg class="who" viewBox="0 0 16 16"><title>caller</title><path d="M3.6 1.5 5.8 1l1.3 3.2-1.6 1.2a8 8 0 0 0 4.1 4.1l1.2-1.6 3.2 1.3-.5 2.2c-.1.6-.7 1.1-1.3 1.1A11.5 11.5 0 0 1 2.5 2.8c0-.6.5-1.2 1.1-1.3z"/></svg>',
  agent: '<svg class="who" viewBox="0 0 16 16"><title>agent (Live)</title><path d="M8 1 2.5 3v4.5c0 3.4 2.3 6.2 5.5 7.5 3.2-1.3 5.5-4.1 5.5-7.5V3z"/></svg>',
};
type Cls = Extract<TimelineEvent, { type: "classification" }>;
/** Choice answers beyond the verdict ("done: continue 0.93 · …"); older events may have none. */
function answers(c: Cls["classification"]) {
  const a = c.answers || {};
  return Object.keys(a)
    .filter((q) => q !== "verdict" && q !== "category")
    .map((q) => q + ": " + a[q]!.choice + " " + (a[q]!.probabilities[a[q]!.choice] ?? 0).toFixed(2));
}
/** Every answer with all its probabilities, highest first. */
function jevTip(ev: Cls) {
  const c = ev.classification;
  const d = ev.decision;
  const a = c.answers || { verdict: { choice: c.verdict, probabilities: { [c.verdict]: c.confidence } } };
  const rows = Object.keys(a)
    .filter((q) => q !== "category")
    .map((q) => {
      const ps = Object.entries(a[q]!.probabilities).sort((x, y) => y[1] - x[1]);
      const cells = ps.map(([k, p]) => (k === a[q]!.choice ? "<b>" + esc(k) + " " + p.toFixed(2) + "</b>" : esc(k) + " " + p.toFixed(2)));
      return "<tr><th>" + esc(q) + "</th><td>" + cells.join(" · ") + "</td></tr>";
    });
  rows.push("<tr><th>urgency</th><td>" + c.urgency.toFixed(2) + "</td></tr>");
  const ou = ev.ownerUpdate;
  if (ou) {
    const due = ou.probability >= ou.min;
    rows.push("<tr><th>owner update</th><td>" + esc(ou.answer) + " " + ou.probability.toFixed(2) + (due ? " <b>≥ " + ou.min + ": summary due</b>" : ' <span class="muted">&lt; ' + ou.min + "</span>") + "</td></tr>");
  }
  return (
    "<h4>Jev · " + fmt(ev.at) + ' <span class="muted">· ' + c.latencyMs + " ms</span></h4><table>" + rows.join("") + "</table>" +
    (d ? '<div class="sec">rule <b>' + esc(d.rule ?? "none") + "</b> → " + esc(d.action.replaceAll("_", " ")) + ' <span class="muted">(' + esc(d.reason) + ")</span></div>" : "")
  );
}
type Append = Extract<TimelineEvent, { type: "live.append" }>;
function appendTip(ev: Append, ctx: number | null) {
  const how = [ev.as, ev.heldMs ? "held " + secs(ev.heldMs) : "sent at once", ev.fallback ? "fallback" : "", ev.dropped ? "dropped" : ""].filter(Boolean);
  return (
    "<h4>" + esc(ev.source) + " → Live · " + fmt(ev.at) + ' <span class="muted">· ' + esc(how.join(" · ")) + "</span></h4>" +
    '<div class="pre">' + esc(ev.text) + "</div>" +
    (ctx !== null ? '<div class="sec muted">Live context in use: ' + pct(ctx) + "%</div>" : "")
  );
}

/** A Luna call's tokens and cost, for its tooltip. */
function usageTip(u: PricedUsage | undefined) {
  if (!u) return "";
  return '<div class="sec muted">$' + u.costUsd.toFixed(4) + " · " + esc(describeLunaTokens(u)) + (u.serviceTier ? " · " + esc(u.serviceTier) : "") + "</div>";
}

/** A live.append row's label, by where the text came from. */
const APPEND_LABELS: Record<AppendSource, string> = {
  stage: "→ Live",
  silence: "silence prompt",
  delegation: "answer to Live",
  luna: "Luna → Live",
  owner: "owner → Live",
};

/** events carry "at" (ms since call start); transcript entries carry entry.at (first word) */
function atOf(ev: TimelineEvent) {
  return ev.type === "transcript" ? ev.entry.at : "at" in ev && typeof ev.at === "number" ? ev.at : 0;
}

export function createTimeline(root: HTMLElement): Timeline {
  const rowsEl = root.querySelector<HTMLElement>("[data-rows]")!;
  const q = (s: string) => root.querySelector<HTMLElement>(`[data-s=${s}]`);
  const st = {
    verdict: q("verdict"),
    urgency: q("urgency"),
    stage: q("stage"),
    luna: q("luna"),
    ctx: q("ctx"),
    jev: q("jev"),
    status: q("status"),
    elapsed: q("elapsed"),
    cost: q("cost"),
    owner: q("owner"),
  };
  const bySeq: Record<number, HTMLElement> = {};
  let ticks = 0;
  let lunaCalls = 0;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let follow = true;
  /** Live's latest context usage (0..1), or null before the first report */
  let ctx: number | null = null;
  /** the call flow's stage (status strip), and the stage of the last text that reached Live (Live lane) */
  let flowStage: string | null = null;
  let liveStage: string | null = null;
  /** a Luna call is running: her lane shows a bar */
  let lunaRunning = false;
  /** each stage's hue in this call: distinct, and kept if the call returns to a stage */
  const hues = new Map<string, number>();
  /** the running Luna call, if any */
  let lunaStart: Extract<TimelineEvent, { type: "luna.started" }> | null = null;
  /** Luna's last finished call, and a text of hers that reached Live before it finished */
  let lastLuna: { sent?: Append } | null = null;
  let lunaSent: Append | undefined;
  /**
   * Flow rows whose work is still under way (a bar in the flow lane): stage texts waiting to reach
   * Live, in order; a Luna call to start; the hang-up; Luna's reply on its way to Live.
   */
  let stageTexts: { stage: string; row: HTMLElement }[] = [];
  let flowLuna: HTMLElement | null = null;
  let flowHangup: HTMLElement | null = null;
  let lunaReply: HTMLElement | null = null;
  /** the last stage text that reached Live (Luna's replies to a rule included) */
  type LiveText = { stage: string; at: number; as?: string };
  let liveText: LiveText | null = null;
  /** Utterances for their hover cards: Live's last stage text when one began, Jev's first result on a caller's. */
  type Utt = { e: TranscriptEntry; live: LiveText | null; jev?: Cls };
  const utts: Record<number, Utt> = {};
  let unjudged: Utt[] = [];
  function uttTip(u: Utt) {
    const e = u.e;
    const span =
      e.endAt !== undefined ? fmt(e.at) + " → " + fmt(e.endAt) + ' <span class="muted">· ' + secs(e.endAt - e.at) + "</span>" : fmt(e.at) + (e.final ? "" : ' <span class="muted">· still speaking</span>');
    const lines: string[] = [];
    if (e.speaker === "agent") {
      if (e.replyMs !== undefined) lines.push("replied " + e.replyMs + " ms after the caller's last transcribed words");
      lines.push(
        u.live
          ? "Live's last stage text: <b>" + esc(u.live.stage) + "</b>" + (u.live.as ? " (" + esc(u.live.as) + ")" : "") + ", reached Live at " + fmt(u.live.at)
          : "no stage text had reached Live yet",
      );
    } else if (u.jev) {
      const c = u.jev.classification, d = u.jev.decision;
      lines.push(
        "first judged by Jev at " + fmt(u.jev.at) + ": <b>" + esc(c.verdict) + " " + c.confidence.toFixed(2) + "</b>" +
          (d && d.action !== "none" ? " → " + esc(d.action.replaceAll("_", " ")) + (d.rule ? " (" + esc(d.rule) + ")" : "") : ' <span class="muted">· no change</span>'),
      );
    } else lines.push('<span class="muted">not judged by Jev yet</span>');
    if (e.itemId) lines.push('<span class="muted">Live item ' + esc(e.itemId) + "</span>");
    return "<h4>" + esc(e.speaker) + " · " + span + "</h4>" + lines.map((l) => "<div>" + l + "</div>").join("");
  }

  /** Hover details: one floating card, filled from the hovered row's tip. */
  const tips = new WeakMap<HTMLElement, () => string>();
  const tipEl = document.createElement("div");
  tipEl.className = "tip";
  root.appendChild(tipEl);
  function showTip(e: MouseEvent) {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".ev");
    const tip = r && tips.get(r);
    if (!tip) return hideTip();
    if (tipEl.dataset.for !== r.dataset.n) {
      tipEl.innerHTML = tip();
      tipEl.dataset.for = r.dataset.n;
    }
    tipEl.classList.add("on");
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    const x = Math.min(e.clientX + 14, window.innerWidth - w - 8);
    const y = e.clientY + 16 + h > window.innerHeight ? e.clientY - h - 10 : e.clientY + 16;
    tipEl.style.left = Math.max(8, x) + "px";
    tipEl.style.top = Math.max(8, y) + "px";
  }
  function hideTip() {
    tipEl.classList.remove("on");
    delete tipEl.dataset.for;
  }
  rowsEl.addEventListener("mousemove", showTip);
  rowsEl.addEventListener("mouseleave", hideTip);
  let rowN = 0;

  function onScroll() {
    follow = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  }
  window.addEventListener("scroll", onScroll);
  function scroll() {
    if (follow) window.scrollTo(0, document.body.scrollHeight);
  }
  function set(el: HTMLElement | null, html: string) {
    if (el) el.innerHTML = html;
  }
  /** The stage's colour on an element (the .st class turns --h into --stage). */
  function tint(el: HTMLElement, name: string) {
    if (!hues.has(name)) hues.set(name, STAGE_HUES[hues.size % STAGE_HUES.length]!);
    el.classList.add("st");
    el.style.setProperty("--h", String(hues.get(name)));
  }

  /** A vertical lane segment; `part`: whole row, from the row's dot down, or down to it. */
  function seg(g: HTMLElement, lane: Lane, cls: string, part: "all" | "below" | "above" = "all") {
    const d = document.createElement("i");
    d.className = "ln " + lane + " " + cls + (part === "all" ? "" : " " + part);
    g.appendChild(d);
    return d;
  }
  function dot(g: HTMLElement, lane: Lane, cls: string) {
    const d = document.createElement("i");
    d.className = "dot " + lane + " " + cls;
    d.style.left = X[lane] + "px";
    g.appendChild(d);
    return d;
  }

  type Arrow = { from: Lane; to: Lane; cls?: string };
  /**
   * A new row: its time, the lanes as they stand (Live in the colour of the last stage text it got, a bar on
   * Luna while she runs), then its arrows and dots.
   */
  function row(opts: { kind: string; at: number; dots?: [Lane, string][]; arrows?: Arrow[]; body: string; tip?: () => string }) {
    const r = document.createElement("div");
    r.className = "ev " + opts.kind + (opts.tip ? " has-tip" : "");
    r.dataset.at = String(opts.at);
    r.dataset.n = String(rowN++);
    if (opts.tip) tips.set(r, opts.tip);
    const g = document.createElement("div");
    g.className = "g";
    for (const lane of ["c", "f", "j"] as Lane[]) seg(g, lane, "");
    const live = seg(g, "l", liveStage ? "staged" : "");
    if (liveStage) tint(live, liveStage);
    seg(g, "u", lunaRunning ? "run" : "");
    for (const a of opts.arrows || []) {
      const el = document.createElement("i");
      const x1 = X[a.from], x2 = X[a.to];
      el.className = "arr " + (x2 > x1 ? "right" : "left") + " " + (a.cls || "");
      el.style.left = Math.min(x1, x2) + "px";
      el.style.width = Math.abs(x2 - x1) + "px";
      g.appendChild(el);
    }
    for (const [lane, cls] of opts.dots || []) dot(g, lane, cls);
    // The time sits left of the lanes, in its own column.
    const t = document.createElement("div");
    t.className = "tm";
    t.textContent = fmt(opts.at);
    const b = document.createElement("div");
    b.className = "b";
    b.innerHTML = opts.body;
    r.append(t, g, b);
    rowsEl.appendChild(r);
    scroll();
    return { r, g, b };
  }

  /**
   * A bar in `lane` from row `from`'s dot down to this row's dot or arrow; `end` marks where it
   * stops. `hold`: a text for Live waiting for the agent to be idle (a bold dashed bar).
   */
  function connect(lane: Lane, from: HTMLElement | null, g: HTMLElement, end = false, hold = false) {
    const to = g.parentElement!;
    if (!from || from === to || !from.isConnected) return;
    const cls = hold ? "run hold" : "run";
    seg(from.querySelector<HTMLElement>(".g")!, lane, cls, "below");
    for (let r = from.nextElementSibling as HTMLElement | null; r && r !== to; r = r.nextElementSibling as HTMLElement | null) {
      seg(r.querySelector<HTMLElement>(".g")!, lane, cls);
    }
    seg(g, lane, cls, "above");
    if (end) dot(g, lane, "tick");
  }
  /** Live's lane takes a stage's colour from this row on. */
  function liveEnters(g: HTMLElement, stage: string) {
    g.querySelector<HTMLElement>(".ln.l")!.classList.add("above");
    liveStage = stage;
    tint(seg(g, "l", "staged", "below"), stage);
  }

  function tick() {
    if (startedAt === null || !st.elapsed) return;
    set(st.elapsed, clock((endedAt || Date.now()) - startedAt));
    if (endedAt) clearInterval(timer);
  }
  const timer = setInterval(tick, 1000);
  // A new test call makes a new timeline on the same page: the old one must stop writing to
  // the shared status strip (its timer kept showing the previous call's length).
  function destroy() {
    clearInterval(timer);
    window.removeEventListener("scroll", onScroll);
    tipEl.remove();
  }

  function classification(ev: Cls) {
    const c = ev.classification;
    ticks++;
    for (const u of unjudged) u.jev = ev;
    unjudged = [];
    set(st.verdict, '<span class="tag ' + c.verdict + '">' + c.verdict + "</span> " + bar(c.confidence, c.verdict) + " " + c.confidence.toFixed(2));
    set(st.urgency, bar(c.urgency) + " " + c.urgency.toFixed(2));
    set(st.jev, ticks + ' <span class="muted">(' + c.latencyMs + " ms)</span>");
    const d = ev.decision;
    const extra = answers(c);
    const tip = () => jevTip(ev);
    // Jev's say on the owner's summary (luna.yaml progress.when): bold when it makes one due.
    const ou = ev.ownerUpdate;
    const ouBadge = ou
      ? ' <span class="ou' + (ou.probability >= ou.min ? " due" : " muted") + '" title="owner update: ' + esc(ou.answer) + " " + ou.probability.toFixed(2) + " (due at ≥ " + ou.min + ')">📝 ' + ou.probability.toFixed(2) + "</span>"
      : "";
    if (ou) set(st.owner, bar(ou.probability) + " " + ou.probability.toFixed(2) + (ou.probability >= ou.min ? " <b>due</b>" : ""));
    const head = '<span class="tag ' + c.verdict + '">' + c.verdict + "</span> " + bar(c.confidence, c.verdict) + " " + c.confidence.toFixed(2) + ouBadge;
    const outcome =
      !d || d.action === "none"
        ? ""
        : d.action === "tell_live"
          ? "→ " + esc(d.reason)
          : d.action === "luna"
            ? "→ ask Luna"
            : d.action === "luna_deferred"
              ? "→ Luna queued" + (d.atMs !== undefined ? " until " + fmt(d.atMs) : "")
              : d.action === "luna_skipped"
                ? "→ Luna skipped: " + esc(d.reason.split("; ").pop())
                : "→ hang up";
    if (!outcome) {
      // Quiet: the flow's rules changed nothing. Details on hover.
      row({ kind: "jev quiet", at: ev.at, dots: [["j", ""]], body: head + ' <span class="muted">· urg ' + c.urgency.toFixed(2) + "</span>", tip });
      return;
    }
    // Jev's answer goes back to the call flow, whose rules decided something.
    const skipped = d!.action === "luna_skipped" || d!.action === "luna_deferred";
    const { r } = row({
      kind: "jev hit" + (skipped ? " skip" : ""),
      at: ev.at,
      dots: [["j", skipped ? "hollow" : "hit"], ["f", "flow"]],
      arrows: [{ from: "j", to: "f" }],
      body:
        head + ' <b class="out">' + outcome + "</b>" +
        // A stage text already names its rule.
        (d!.rule && d!.action !== "tell_live" ? ' <span class="muted">(' + esc(d!.rule) + ")</span>" : "") +
        (extra.length ? '<span class="xa">' + extra.map((x) => "<i>" + esc(x) + "</i>").join(" · ") + "</span>" : ""),
      tip,
    });
    if (d!.action === "tell_live" && d!.rule) stageTexts.push({ stage: d!.rule, row: r });
    else if (d!.action === "luna" || d!.action === "luna_deferred") flowLuna = r;
    else if (d!.action === "end_call") flowHangup = r;
  }

  function on(ev: TimelineEvent) {
    switch (ev.type) {
      case "call.started":
        startedAt = ev.meta.startedAt;
        set(st.status, '<span class="tag live">live</span>');
        tick();
        break;
      case "transcript": {
        const e = ev.entry;
        let el = bySeq[e.seq];
        if (!el) {
          const u: Utt = { e, live: liveText };
          utts[e.seq] = u;
          if (e.speaker === "caller") unjudged.push(u);
          el = row({ kind: "tx " + e.speaker, at: e.at, dots: [[e.speaker === "caller" ? "c" : "l", e.speaker]], body: "", tip: () => uttTip(u) }).b;
          bySeq[e.seq] = el;
        }
        utts[e.seq]!.e = e;
        el.innerHTML = '<div class="utt ' + e.speaker + (e.final ? "" : " partial") + '">' + (WHO[e.speaker] ?? "") + esc(e.text) + "</div>";
        scroll();
        break;
      }
      case "classification":
        classification(ev);
        break;
      case "stage":
      case "strategy": {
        // The call flow enters a stage; Live's lane follows once the stage's text reaches it.
        // strategy: calls recorded before the call flow, told to Live at once.
        const next = ev.type === "stage" ? ev.stage : ev.strategyId;
        if (next === flowStage) break;
        flowStage = next;
        const { g, b } = row({ kind: "stage", at: ev.at, body: "" });
        tint(dot(g, "f", "stage"), next);
        if (ev.type === "strategy") {
          liveEnters(g, next);
          liveText = { stage: next, at: ev.at, ...(ev.as ? { as: ev.as } : {}) };
        }
        tint(b, next);
        b.innerHTML = "<b>" + esc(next) + '</b> <span class="muted">call flow' + (ev.as ? " · " + esc(ev.as) + " for Live" : "") + "</span>";
        set(st.stage, '<i class="sdot"></i>' + esc(next));
        if (st.stage) tint(st.stage, next);
        break;
      }
      case "live.append": {
        const how = [ev.as, ev.heldMs >= 200 ? "held " + secs(ev.heldMs) : "", ev.fallback ? "fallback" : "", ev.dropped ? "dropped" : ""].filter(Boolean);
        const label = APPEND_LABELS[ev.source] ?? "→ Live";
        const fromLuna = ev.source === "luna" || ev.source === "delegation";
        if (fromLuna) {
          // Luna's reply (or the fallback) reaching Live: shown with her call too.
          if (lunaRunning) lunaSent = ev;
          else if (lastLuna && !lastLuna.sent) lastLuna.sent = ev;
        }
        const usage = ctx;
        // Every text reaches Live from the call flow (a stage text, Luna's reply, the silence watchdog).
        const { g } = row({
          kind: "append" + (ev.source === "owner" ? " owner" : "") + (ev.dropped ? " dropped" : ""),
          at: ev.at,
          arrows: [{ from: "f", to: "l", cls: fromLuna ? "luna" : "" }],
          body:
            '<span class="line">' + "<b>" + label + '</b> <span class="muted">' + esc(how.join(" · ")) +
            '</span> <span class="txt">' + esc(ev.text) + "</span></span>",
          tip: () => appendTip(ev, usage),
        });
        if (!ev.dropped && ev.stage && ev.source !== "silence") {
          if (ev.stage !== liveStage) liveEnters(g, ev.stage);
          liveText = { stage: ev.stage, at: ev.at, as: ev.as };
        }
        const d = dot(g, "l", "in");
        if (liveStage) tint(d, liveStage);
        if (ev.source === "stage") {
          // The decision that sent it; older ones still waiting were superseded.
          const i = stageTexts.findIndex((x) => x.stage === ev.stage);
          if (i >= 0) connect("f", stageTexts[i]!.row, g, false, true);
          stageTexts = stageTexts.slice(i + 1);
        } else if (fromLuna && !lunaRunning) {
          connect("f", lunaReply, g, false, true);
          lunaReply = null;
        }
        break;
      }
      case "luna.started": {
        const who =
          ev.trigger === "delegation" ? "Live asks for help" : ev.trigger === "summary" ? "summarise the call" : esc(ev.reason);
        lunaStart = ev;
        // The call flow calls Luna; Live's request for help goes through it.
        const { g } = row({
          kind: "luna start",
          at: ev.at,
          dots: [["u", "luna"]],
          arrows: [{ from: ev.trigger === "delegation" ? "l" : "f", to: "u", cls: "luna" }],
          body: "<b>Luna</b> " + '<span class="muted">← ' + who + "</span>",
          tip: () => "<h4>Luna starts · " + fmt(ev.at) + ' <span class="muted">· ' + esc(ev.trigger) + '</span></h4><div class="pre">' + esc(ev.reason) + "</div>",
        });
        g.querySelector(".ln.u")!.classList.add("run", "below");
        lunaRunning = true;
        if (ev.trigger === "rule") {
          connect("f", flowLuna, g);
          flowLuna = null;
        }
        break;
      }
      case "luna": {
        lunaCalls++;
        set(st.luna, String(lunaCalls));
        const wasRunning = lunaRunning;
        lunaRunning = false;
        const took = lunaStart ? ev.at - lunaStart.at : null;
        lunaStart = null;
        const rec: { sent?: Append } = { sent: lunaSent };
        lunaSent = undefined;
        lastLuna = rec;
        const reply = ev.instructions
          ? '<span class="txt' + (ev.dropped ? " struck" : "") + '">' + esc(ev.instructions) + "</span>"
          : '<span class="muted">no guidance</span>';
        // Her reply goes back to the call flow.
        const { r, g } = row({
          kind: "luna done",
          at: ev.at,
          dots: [["u", "luna"], ["f", "flow"]],
          arrows: [{ from: "u", to: "f", cls: "luna" }],
          body:
            '<span class="line">' + "<b>Luna</b> " + reply + "</span>" +
            (ev.dropped ? '<span class="xa">not sent: ' + esc(ev.dropped) + "</span>" : "") +
            (ev.toolCalls.length ? '<span class="xa">tools: ' + ev.toolCalls.map((x) => esc(x.name) + " → " + esc(x.result)).join(", ") + "</span>" : ""),
          tip: () =>
            "<h4>Luna · " + fmt(ev.at) + ' <span class="muted">· ' + [ev.trigger, took !== null ? "took " + secs(took) : ""].filter(Boolean).map(esc).join(" · ") + "</span></h4>" +
            '<div class="muted">task</div><div class="pre">' + esc(ev.reason) + "</div>" +
            '<div class="sec muted">reply</div><div class="pre">' + (ev.instructions ? esc(ev.instructions) : '<span class="muted">no guidance</span>') + "</div>" +
            (ev.dropped ? '<div class="muted">not sent: ' + esc(ev.dropped) + "</div>" : "") +
            ev.toolCalls.map((x) => '<div class="sec"><b>' + esc(x.name) + "</b> → " + esc(x.result) + "<pre>" + esc(JSON.stringify(x.args, null, 2)) + "</pre></div>").join("") +
            usageTip(ev.usage) +
            (rec.sent ? '<div class="sec muted">sent to Live · ' + esc(rec.sent.as) + (rec.sent.heldMs ? " · held " + secs(rec.sent.heldMs) : "") + (rec.sent.dropped ? " · dropped" : "") + '</div><div class="pre">' + esc(rec.sent.text) + "</div>" : ""),
        });
        if (wasRunning) g.querySelector(".ln.u")!.classList.add("run", "above");
        // Her reply is still to reach Live (held until the agent is idle), or Live awaits an answer.
        const pending = !rec.sent && ((ev.instructions && !ev.dropped) || ev.trigger === "delegation");
        lunaReply = pending ? r : null;
        break;
      }
      case "live.usage":
        if (typeof ev.contextRatio !== "number") break;
        ctx = ev.contextRatio;
        set(st.ctx, bar(ctx) + " " + pct(ctx) + "%");
        break;
      case "tool":
        row({
          kind: "tool",
          at: ev.at,
          dots: [["u", "small"]],
          body: "<b>tool</b> " + esc(ev.call.name) + ' <span class="muted">→ ' + esc(ev.call.result) + "</span>",
          tip: () => "<h4>tool " + esc(ev.call.name) + " · " + fmt(ev.at) + "</h4><div>→ " + esc(ev.call.result) + "</div><pre>" + esc(JSON.stringify(ev.call.args, null, 2)) + "</pre>",
        });
        break;
      case "costs":
        // Final costs, with the end-of-call summary priced in.
        lunaCalls = ev.costs.luna.calls;
        set(st.luna, String(lunaCalls));
        row({ kind: "note info", at: ev.at, body: "cost " + esc(describeCosts(ev.costs)) + " · Luna " + ev.costs.luna.calls + " calls, " + esc(describeLunaTokens(ev.costs.luna)) });
        set(st.cost, esc(describeCosts(ev.costs)));
        break;
      case "progress": {
        // Luna's rolling summary for the owner's Telegram status message; never reaches Live.
        lunaCalls++;
        set(st.luna, String(lunaCalls));
        const sug = ev.suggestions ?? [];
        row({
          kind: "progress",
          at: ev.at,
          dots: [["u", "small"]],
          body:
            '<span class="line"><b>status for owner</b>' + (ev.alert ? " 🚨" : "") + ' <span class="txt">' + esc(ev.summary) + "</span></span>" +
            (ev.questions.length ? '<span class="xa">' + ev.questions.map((x) => "❓ " + esc(x)).join(" · ") + "</span>" : "") +
            (sug.length ? '<span class="xa">' + sug.map((s) => "🔘 " + esc(s.label)).join(" · ") + "</span>" : ""),
          tip: () =>
            "<h4>Luna · status for owner · " + fmt(ev.at) + ' <span class="muted">· took ' + secs(ev.tookMs ?? 0) + "</span></h4>" +
            '<div class="muted">why</div><div class="pre">' + esc(ev.reason ?? "") + "</div>" +
            '<div class="sec muted">summary</div><div class="pre">' + esc(ev.summary) + "</div>" +
            (ev.questions.length ? '<div class="sec muted">questions</div><div class="pre">' + ev.questions.map(esc).join("\n") + "</div>" : "") +
            (sug.length ? '<div class="sec muted">suggested buttons</div><div class="pre">' + sug.map((s) => esc(s.label) + ": " + esc(s.text)).join("\n") + "</div>" : "") +
            (ev.alert ? '<div class="sec muted">alert</div><div class="pre">asked to alert the owner</div>' : "") +
            usageTip(ev.usage),
        });
        break;
      }
      case "note":
        row({ kind: "note " + ev.level, at: ev.at, body: esc(ev.message) });
        break;
      case "call.ended": {
        endedAt = startedAt === null ? null : startedAt + ev.at;
        // Calls from before costs were recorded only have the estimate.
        const cost = ev.costs ? describeCosts(ev.costs) : "est. $" + ev.costUsd.toFixed(3);
        const { g } = row({ kind: "end", at: ev.at, body: "<b>ended</b> " + esc(ev.reason) + ' <span class="muted">· ' + esc(cost) + "</span>" });
        set(st.cost, esc(cost));
        // A rule's hang-up waits for the agent's goodbye to play out.
        if (flowHangup) connect("f", flowHangup, g, true);
        else dot(g, "f", "tick");
        flowHangup = null;
        set(st.status, '<span class="tag">ended</span> <span class="muted">' + esc(ev.reason) + "</span>");
        tick();
        break;
      }
      case "summary": {
        // Luna writes it (luna.yaml summary_instructions); it ends her summary call.
        const took = lunaStart?.trigger === "summary" ? ev.at - lunaStart.at : null;
        const wasRunning = lunaRunning;
        lunaRunning = false;
        lunaStart = null;
        const { g } = row({
          kind: "summary",
          at: ev.at,
          dots: [["u", "luna"], ["f", "flow"]],
          arrows: [{ from: "u", to: "f", cls: "luna" }],
          body: "<b>summary</b> " + esc(ev.text) + (ev.reused ? ' <span class="muted">(last status for owner)</span>' : ""),
          tip: () =>
            "<h4>Luna summary · " + fmt(ev.at) + (took !== null ? ' <span class="muted">· took ' + secs(took) + "</span>" : "") + "</h4>" +
            '<div class="pre">' + esc(ev.text) + "</div>" +
            (ev.reused ? '<div class="sec muted">No Luna call: the caller said nothing new after the last status for the owner, so it is reused.</div>' : "") +
            usageTip(ev.usage),
        });
        if (wasRunning) g.querySelector(".ln.u")!.classList.add("run", "above");
        break;
      }
    }
  }

  /** Stored events: transcript rows are persisted when an utterance ends, so order by time. */
  function load(events: TimelineEvent[]) {
    events
      .map((ev, i) => ({ ev, i }))
      .sort((a, b) => atOf(a.ev) - atOf(b.ev) || a.i - b.i)
      .forEach((x) => on(x.ev));
  }

  return { on, load, destroy };
}
