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
// Take over (only on a live phone call with takeover set up): the takeover page, in a new tab so
// this one stays in view. Hidden while taken over and once the call ends.
const takeoverBtn = document.getElementById("takeover") as HTMLButtonElement | null;
if (takeoverBtn) takeoverBtn.onclick = () => void window.open(takeoverBtn.dataset.href, "_blank");
function takeoverEvent(type: string) {
  if (!takeoverBtn) return;
  if (type === "takeover.started" || type === "takeover.live") takeoverBtn.hidden = true;
  else if (type === "takeover.failed") takeoverBtn.hidden = false;
  else if (type === "call.ended") takeoverBtn.remove();
}

const ws = new WebSocket(wsUrl("/ws?callId=" + encodeURIComponent(callId)));
ws.onmessage = (m) => {
  const ev = JSON.parse(m.data) as TimelineEvent;
  takeoverEvent(ev.type);
  tl.on(ev);
  if (isCallInfo(ev)) info.add(ev);
  if (ev.type === "recording") location.reload();
};
