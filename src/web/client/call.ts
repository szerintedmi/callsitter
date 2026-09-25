// Call detail page: the stored events, then live ones, on the timeline.

import { createTimeline, type TimelineEvent } from "./timeline";
import { wsUrl } from "./ws";

const callId = document.querySelector<HTMLElement>("[data-call]")!.dataset.call!;
const tl = createTimeline(document.getElementById("timeline")!);
tl.load(JSON.parse(document.getElementById("initial")!.textContent!));
const ws = new WebSocket(wsUrl("/ws?callId=" + encodeURIComponent(callId)));
ws.onmessage = (m) => {
  const ev = JSON.parse(m.data) as TimelineEvent;
  tl.on(ev);
  if (ev.type === "recording") location.reload();
};
