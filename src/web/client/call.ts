// Call detail page: the stored events, then live ones, on the timeline.

import { createCallInfo, isCallInfo } from "./call-info";
import { createTimeline, type TimelineEvent } from "./timeline";
import { wsUrl } from "./ws";

const callId = document.querySelector<HTMLElement>("[data-call]")!.dataset.call!;
const tl = createTimeline(document.getElementById("timeline")!);
const info = createCallInfo(document.getElementById("callinfo")!);
const initial = JSON.parse(document.getElementById("initial")!.textContent!) as TimelineEvent[];
tl.load(initial);
for (const ev of initial) if (isCallInfo(ev)) info.add(ev);
const ws = new WebSocket(wsUrl("/ws?callId=" + encodeURIComponent(callId)));
ws.onmessage = (m) => {
  const ev = JSON.parse(m.data) as TimelineEvent;
  tl.on(ev);
  if (isCallInfo(ev)) info.add(ev);
  if (ev.type === "recording") location.reload();
};
