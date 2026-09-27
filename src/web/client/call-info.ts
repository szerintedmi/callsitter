// The call's carrier-level info, collapsed: the SIP headers it arrived with and the carrier's
// metadata (debugging caller ID, diversion, carrier headers), and the carrier's account of the
// hangup. The call page and the test-call page fill it from stored events and live ones, so it
// shows during the call too.

import type { CallEvent } from "../../core/types";

export type CallInfoEvent = Extract<CallEvent, { type: "sip.headers" | "carrier.hangup" }>;

export const isCallInfo = (ev: { type: string }): ev is CallInfoEvent => ev.type === "sip.headers" || ev.type === "carrier.hangup";

export interface CallInfo {
  add(ev: CallInfoEvent): void;
  clear(): void;
}

const SOURCE = { openai: "OpenAI (live.transport.incoming)", telnyx: "Telnyx (call.initiated)" };

export function createCallInfo(root: HTMLElement): CallInfo {
  let events: CallInfoEvent[] = [];
  let open = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // carrier and caller-controlled values: never innerHTML
    return e;
  };
  const table = (parent: HTMLElement, rows: [string, string][]) => {
    const tbody = parent.appendChild(el("table", "sip")).appendChild(el("tbody"));
    for (const [name, value] of rows) {
      const tr = tbody.appendChild(el("tr"));
      tr.appendChild(el("th", undefined, name));
      tr.appendChild(el("td", undefined, value));
    }
  };

  function render() {
    root.innerHTML = "";
    if (!events.length) return;
    const details = el("details", "debug");
    details.open = open;
    details.addEventListener("toggle", () => (open = details.open));
    const headers = events.reduce((n, e) => n + (e.type === "sip.headers" ? e.headers.length : 0), 0);
    const arrived = events.some((e) => e.type === "sip.headers");
    details.appendChild(el("summary", undefined, `Call info${arrived ? ` (${headers ? `${headers} SIP headers` : "no SIP headers"})` : ""}`));
    for (const e of events) {
      const wrap = details.appendChild(el("div", "wrap"));
      if (e.type === "sip.headers") {
        wrap.appendChild(el("p", "muted", `from ${SOURCE[e.source]}${e.mediaSecurity ? ` · media ${e.mediaSecurity}` : ""}`));
        if (e.info) table(wrap, Object.entries(e.info));
        if (e.headers.length) {
          if (e.info) wrap.appendChild(el("p", "muted", "SIP headers"));
          table(wrap, e.headers.map((h) => [h.name, h.value]));
        } else wrap.appendChild(el("p", "muted", "no SIP headers received"));
      } else {
        wrap.appendChild(el("p", "muted", "hangup, from Telnyx (call.hangup)"));
        table(wrap, Object.entries(e.info));
      }
    }
    root.appendChild(details);
  }

  return {
    add(ev) {
      // The same event can come from both the stored list and the live socket.
      if (events.some((s) => s.type === ev.type && s.source === ev.source && s.at === ev.at)) return;
      events = [...events, ev];
      render();
    },
    clear() {
      events = [];
      render();
    },
  };
}
