// Call list page: reloads when a call starts, ends or gets its summary.

import type { CallEvent } from "../../core/types";
import { wsUrl } from "./ws";

const ws = new WebSocket(wsUrl("/ui/ws"));
ws.onmessage = (e) => {
  const t = (JSON.parse(e.data) as CallEvent).type;
  if (t === "call.started" || t === "call.ended" || t === "summary") location.reload();
};
