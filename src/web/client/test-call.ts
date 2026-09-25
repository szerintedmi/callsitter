// Test-call page controller. See src/web/test-call.ts for the protocol.

import type { CallEvent, SipHeader } from "../../core/types";
import { TEST_CALL_PROTOCOL } from "../test-call-protocol";
import { createTimeline, type Timeline } from "./timeline";
import { wsUrl } from "./ws";

// The parts of the Telnyx WebRTC SDK (loaded from the CDN below) this page uses.
interface TelnyxCall {
  state: string;
  cause?: string;
  causeCode?: number;
  sipCode?: number;
  sipReason?: string;
  peer?: { instance?: RTCPeerConnection };
  hangup(): void;
}
interface TelnyxRtc {
  on(event: string, fn: (e: any) => void): void;
  connect(): void;
  disconnect(): void;
  newCall(opts: { destinationNumber: string; callerNumber: string; audio: boolean; remoteElement: string; customHeaders: SipHeader[] }): TelnyxCall;
}
declare global {
  interface Window {
    TelnyxWebRTC?: { TelnyxRTC: new (opts: { login_token: string }) => TelnyxRtc };
  }
}

type Level = "info" | "warn" | "error";
type ServerMsg =
  | { type: "started"; callId: string }
  | { type: "event"; event: CallEvent }
  | { type: "clear" }
  | { type: "error"; message: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Same ?v= build tag as this script, so the worklet is never a stale cached copy either.
const V = (document.currentScript as HTMLScriptElement | null)?.src.split("?")[1] || "";
const startBtn = $<HTMLButtonElement>("start"), hangupBtn = $<HTMLButtonElement>("hangup"), dry = $<HTMLInputElement>("dry");
const statusEl = $("status"), meter = $("meter"), link = $("calllink");
const route = $<HTMLSelectElement>("route");
let timeline: Timeline | null = null, ws: WebSocket | null = null, ctx: AudioContext | null = null, stream: MediaStream | null = null;
let capture: AudioWorkletNode | null = null, player: AudioWorkletNode | null = null, upLast = 0, upPos = 0;
let userHungUp = false;

const errText = (err: any) => String(err && err.message ? err.message : err);

function status(s: string) {
  statusEl.textContent = s;
}

function newTimeline() {
  $("rows").innerHTML = "";
  timeline?.destroy();
  return (timeline = createTimeline($("timeline")));
}

// Debug log: page events (Telnyx SDK, sockets, fetches) plus the server's log lines, polled
// from /ui/debug/log. Newest last; the summary shows the error count.
const logEl = $("debuglog"), logCount = $("debugcount");
let errors = 0, serverSeq = 0;
function dbg(level: Level, msg: string, at?: number, src?: string) {
  const line = document.createElement("div");
  line.className = "dl " + level;
  const t = new Date(at || Date.now()).toLocaleTimeString("en-GB", { hour12: false }) + "." + String((at || Date.now()) % 1000).padStart(3, "0");
  line.textContent = t + "  " + (src || "page") + "  " + msg;
  logEl.appendChild(line);
  while (logEl.childNodes.length > 500) logEl.removeChild(logEl.firstChild!);
  logEl.scrollTop = logEl.scrollHeight;
  if (level === "error") {
    errors++;
    logCount.textContent = " (" + errors + " error" + (errors > 1 ? "s" : "") + ")";
  }
}
function pollServerLog() {
  fetch("/ui/debug/log?after=" + serverSeq)
    .then((r) => (r.ok ? r.json() : { lines: [] }))
    .then((j: { lines: { seq: number; level: Level; text: string; at: number }[] }) => {
      j.lines.forEach((l) => {
        serverSeq = l.seq;
        dbg(l.level, l.text, l.at, "server");
      });
    })
    .catch(() => {});
}
// Skip lines from before the page loaded, then keep polling.
fetch("/ui/debug/log?after=0&tail=0")
  .then((r) => (r.ok ? r.json() : { last: 0 }))
  .then((j: { last?: number }) => {
    serverSeq = j.last || 0;
    setInterval(pollServerLog, 1000);
  })
  .catch(() => {});
$("debugclear").onclick = (e) => {
  e.preventDefault();
  logEl.innerHTML = "";
  errors = 0;
  logCount.textContent = "";
};

// 16 kHz PCM16 → Float32 at the context rate (linear interpolation, stateful across chunks).
function upsample(pcm: Int16Array, rate: number) {
  const step = 16000 / rate, out: number[] = [];
  while (upPos <= pcm.length - 1) {
    const i = Math.floor(upPos);
    const f = upPos - i, a = i < 0 ? upLast : pcm[i]! / 32768, b = pcm[i + 1] !== undefined ? pcm[i + 1]! / 32768 : a;
    out.push(a + (b - a) * f);
    upPos += step;
  }
  upPos -= pcm.length;
  upLast = pcm[pcm.length - 1]! / 32768;
  return new Float32Array(out);
}

async function start() {
  userHungUp = false;
  startBtn.disabled = true;
  dry.disabled = true;
  route.disabled = true;
  // The previous call's socket may still be open, waiting for its summary: drop it so its
  // late messages can't touch this call.
  if (ws) {
    ws.onmessage = null;
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (route.value === "sip") return startSip();
  try {
    status("requesting microphone…");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/ui/assets/test-call-worklet.js" + (V ? "?" + V : ""));
    const src = ctx.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(ctx, "capture");
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the capture node pulled by the graph without playing the mic back
    src.connect(capture).connect(mute).connect(ctx.destination);
    const p = (player = new AudioWorkletNode(ctx, "player", { outputChannelCount: [1] }));
    p.connect(ctx.destination);
    p.port.onmessage = (e) => {
      if (e.data === "underrun" && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "underrun" }));
    };
    upLast = 0;
    upPos = 0;

    const tl = newTimeline();
    status("connecting…");
    const sock = (ws = new WebSocket(wsUrl("/ui/test-call/ws")));
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      dbg("info", "test-call socket open");
      sock.send(JSON.stringify({ type: "start", dryRun: dry.checked, protocol: TEST_CALL_PROTOCOL }));
    };
    sock.onmessage = (m) => {
      if (typeof m.data !== "string") {
        if (!ctx) return;
        const f = upsample(new Int16Array(m.data as ArrayBuffer), ctx.sampleRate);
        p.port.postMessage(f, [f.buffer]);
        return;
      }
      const msg = JSON.parse(m.data) as ServerMsg;
      if (msg.type === "started") {
        status("connected: talk now (use headphones)");
        link.innerHTML = '<a href="/ui/calls/' + msg.callId + '">call record</a>';
        hangupBtn.disabled = false;
      } else if (msg.type === "event") {
        tl.on(msg.event);
        if (msg.event.type === "call.ended") {
          stopAudio(!userHungUp);
          // A call can be started again now; the summary (if any) still arrives on this socket.
          startBtn.disabled = false;
          dry.disabled = false;
          route.disabled = false;
          status("call ended: waiting for the summary…");
        } else if (msg.event.type === "summary") stop("call ended", !userHungUp);
        if (msg.event.type === "note") dbg(msg.event.level, "call note: " + msg.event.message);
      } else if (msg.type === "clear") p.port.postMessage("clear");
      else if (msg.type === "error") {
        dbg("error", msg.message);
        status("error: " + msg.message);
      }
    };
    sock.onclose = (e) => {
      dbg(e.code === 1000 || e.code === 1005 ? "info" : "warn", "test-call socket closed (" + e.code + (e.reason ? " " + e.reason : "") + ")");
      stop("call ended", !userHungUp);
    };
    capture.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (!ctx) return;
      meter.style.width = Math.min(100, Math.round(e.data.level * 400)) + "%";
      if (ws && ws.readyState === 1) ws.send(e.data.pcm); // raw PCM16LE, 20 ms
    };
  } catch (err) {
    dbg("error", "could not start: " + errText(err));
    status("could not start: " + errText(err));
    stop();
  }
}

/**
 * Stops the mic now. With drain=true, lets the player finish what the agent already said (a
 * goodbye before an agent/Luna hangup) before closing the audio context; bounded at 15 s.
 */
function stopAudio(drain?: boolean) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  meter.style.width = "0";
  hangupBtn.disabled = true;
  const c = ctx;
  if (!c) return;
  const close = () => {
    if (ctx === c) ctx = null;
    if (c.state !== "closed") void c.close();
  };
  if (!drain || !player) return close();
  player.port.onmessage = (e) => {
    if (e.data === "drained") close();
  };
  player.port.postMessage("drain");
  setTimeout(close, 15000);
}

function stop(msg?: string, drain?: boolean) {
  if (ws && ws.readyState <= 1) ws.close();
  ws = null;
  stopAudio(drain);
  stopSip();
  sipBusy = false;
  startBtn.disabled = false;
  dry.disabled = false;
  route.disabled = false;
  hangupBtn.disabled = true;
  if (msg) status(msg);
}

// SIP route: browser → Telnyx WebRTC (parked) → our /telnyx/webhook transfers it to OpenAI's
// SIP endpoint → our /openai/webhook → sideband. (A WebRTC client can't dial an external SIP
// URI: Telnyx answers 404 D11.) The server hands out a Telnyx login token and a nonce, which
// the page dials as part of the destination and sends as a SIP header; it then polls for the
// call id to show events. Every failure path ends in endSip(), so the page never waits on a
// call that is gone. SDK teardown is deferred out of SDK callbacks: calling hangup() on an
// ended call makes the SDK re-emit hangup/destroy synchronously, which can loop.
const SDK_URL = "https://cdn.jsdelivr.net/npm/@telnyx/webrtc@2.27.10/lib/bundle.js";
const SDK_SRI = "sha384-Cg5mHDa8vZl3NVINnhGwGfzhF4ikUKtETZfyY3DVTBAwWzu+fKMyE5Rm68pGdk09";
const SETUP_TIMEOUT_MS = 30000;
let rtc: TelnyxRtc | null = null, sipCall: TelnyxCall | null = null, events: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null, setupTimer: ReturnType<typeof setTimeout> | null = null;
let sipLive = false, sipBusy = false, lastState = "";
let attempt = 0; // bumped per SIP call; SDK events from an older attempt are ignored

function loadSdk() {
  if (window.TelnyxWebRTC) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SDK_URL;
    el.integrity = SDK_SRI;
    el.crossOrigin = "anonymous";
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("could not load the Telnyx WebRTC SDK"));
    document.head.appendChild(el);
  });
}

/**
 * Tells the server our audio is up, so Live says the greeting now rather than into a leg we
 * can't hear yet. "active" can come before the peer connection carries media: wait for that,
 * up to 2 s (the server greets anyway after connection.sip.test_greeting_wait_ms).
 */
function reportConnected(call: TelnyxCall, nonce: string) {
  const started = Date.now();
  const send = (how: string) => {
    dbg("info", "audio " + how + " after " + (Date.now() - started) + " ms: telling the server to greet");
    fetch("/ui/test-call/sip/" + nonce + "/connected", { method: "POST" }).catch(() => {});
  };
  const check = () => {
    const pc = call.peer?.instance;
    const st: string = pc ? pc.connectionState || pc.iceConnectionState : "";
    if (st === "connected" || st === "completed") return send("connected");
    if (Date.now() - started >= 2000) return send("not confirmed (" + (st || "no peer connection") + ")");
    setTimeout(check, 50);
  };
  check();
}

function watchCall(nonce: string, tl: Timeline) {
  let tries = 0;
  pollTimer = setInterval(() => {
    if (++tries > 40) {
      clearInterval(pollTimer!);
      pollTimer = null;
      dbg("error", "no webhook matched this call after 20 s: check the server log below");
      status("in call, but the OpenAI webhook never matched it (see debug log)");
      return;
    }
    fetch("/ui/test-call/sip/" + nonce)
      .then((r) => r.json())
      .then((j: { callId?: string | null }) => {
        if (!j.callId || !pollTimer) return;
        clearInterval(pollTimer);
        pollTimer = null;
        dbg("info", "webhook matched: call " + j.callId);
        fetch("/ui/calls/" + j.callId + "/sip-headers")
          .then((r) => (r.ok ? r.json() : []))
          .then((sets: SipHeadersEvent[]) => sets.forEach(logSipHeaders))
          .catch(() => {});
        link.innerHTML = '<a href="/ui/calls/' + j.callId + '">call record</a>';
        events = new WebSocket(wsUrl("/ui/ws?callId=" + j.callId));
        events.onmessage = (m) => {
          const ev = JSON.parse(m.data) as CallEvent;
          tl.on(ev);
          if (ev.type === "note") dbg(ev.level, "call note: " + ev.message);
          if (ev.type === "summary") stop("call ended");
        };
      })
      .catch(() => {});
  }, 500);
}

type SipHeadersEvent = Extract<CallEvent, { type: "sip.headers" }>;
function logSipHeaders(ev: SipHeadersEvent) {
  dbg("info", "SIP headers from " + ev.source + (ev.mediaSecurity ? " (media " + ev.mediaSecurity + ")" : "") + ":");
  ev.headers.forEach((h) => dbg("info", "  " + h.name + ": " + h.value));
}

/** Describes a Telnyx call update: state plus any cause / SIP code the SDK reports. */
function describeCall(c: TelnyxCall) {
  const parts = [c.state];
  if (c.cause) parts.push("cause " + c.cause + (c.causeCode ? " (" + c.causeCode + ")" : ""));
  if (c.sipCode) parts.push("SIP " + c.sipCode + (c.sipReason ? " " + c.sipReason : ""));
  return parts.join(", ");
}

function describeErr(e: any): string {
  const err = e && (e.error || e);
  if (!err) return "unknown error";
  return err.message || err.description || (typeof err === "string" ? err : JSON.stringify(err));
}

async function startSip() {
  stopSip();
  const me = ++attempt;
  const mine = () => me === attempt && sipBusy;
  sipBusy = true;
  sipLive = false;
  lastState = "";
  hangupBtn.disabled = false; // aborting must work from the first click on
  try {
    const tl = newTimeline();
    status("getting a Telnyx login token…");
    dbg("info", "POST /ui/test-call/sip");
    const r = await fetch("/ui/test-call/sip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: dry.checked }) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; token: string; nonce: string; header: string; dial: string; sipUri: string };
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    if (!mine()) return; // hung up meanwhile
    dbg("info", "got a login token; dialling " + j.dial + " (parks at Telnyx, then our webhook transfers it to " + j.sipUri + ")");
    await loadSdk();
    if (!mine()) return;
    status("connecting to Telnyx…");
    const client = (rtc = new window.TelnyxWebRTC!.TelnyxRTC({ login_token: j.token }));
    setupTimer = setTimeout(() => {
      if (mine() && !sipLive) endSip("no answer after " + SETUP_TIMEOUT_MS / 1000 + " s (last state: " + (lastState || "not connected to Telnyx") + ")", "error");
    }, SETUP_TIMEOUT_MS);
    client.on("telnyx.ready", () => {
      if (!mine()) return;
      dbg("info", "Telnyx ready; dialling " + j.dial);
      status("dialling OpenAI through Telnyx…");
      sipCall = client.newCall({
        destinationNumber: j.dial,
        callerNumber: "scamsittertest",
        audio: true,
        remoteElement: "remote",
        customHeaders: [{ name: j.header, value: j.nonce }],
      });
    });
    client.on("telnyx.error", (e) => {
      if (mine()) endSip("Telnyx error: " + describeErr(e), "error");
    });
    client.on("telnyx.socket.error", (e) => {
      if (mine()) endSip("Telnyx socket error: " + describeErr(e), "error");
    });
    client.on("telnyx.socket.close", () => {
      if (mine()) endSip("Telnyx connection closed", "warn");
    });
    client.on("telnyx.notification", (n: { type: string; call?: TelnyxCall }) => {
      if (!mine()) return;
      if (n.type !== "callUpdate" || !n.call) {
        dbg("info", "Telnyx notification: " + n.type);
        return;
      }
      const c = n.call, d = describeCall(c);
      if (c.state !== lastState) dbg(c.state === "hangup" || c.state === "destroy" ? "warn" : "info", "SIP call: " + d);
      lastState = c.state;
      if (c.state === "active") {
        sipLive = true;
        if (setupTimer) clearTimeout(setupTimer);
        status("connected over SIP: talk now (use headphones)");
        reportConnected(c, j.nonce);
        watchCall(j.nonce, tl);
      } else if (c.state === "hangup" || c.state === "destroy") {
        sipCall = null;
        endSip("call ended (" + d + ")", "info");
      } else status("SIP call: " + d);
    });
    client.connect();
  } catch (err) {
    endSip("could not start: " + errText(err), "error");
  }
}

/**
 * Ends the SIP leg and resets the page. If the server already has the call, its events socket
 * stays open (up to 20 s) so call.ended and the summary still arrive.
 */
function endSip(msg: string, level?: Level) {
  if (!sipBusy) return; // already ended (hangup and destroy both arrive)
  sipBusy = false;
  dbg(level || "info", msg);
  const ev = events;
  events = null;
  stopSip();
  startBtn.disabled = false;
  dry.disabled = false;
  route.disabled = false;
  hangupBtn.disabled = true;
  if (ev && ev.readyState <= 1) {
    events = ev;
    status(msg + ": waiting for the summary…");
    setTimeout(() => {
      if (events === ev) {
        ev.close();
        events = null;
      }
    }, 20000);
  } else status(msg);
}

function stopSip() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (setupTimer) clearTimeout(setupTimer);
  setupTimer = null;
  const c = sipCall, t = rtc;
  sipCall = null;
  rtc = null;
  if (events && events.readyState <= 1) events.close();
  events = null;
  // Outside the current (possibly SDK) callback; only hang up a call that is still up.
  if (c || t)
    setTimeout(() => {
      if (c && !/^(hangup|destroy|purge)$/.test(c.state)) {
        try {
          c.hangup();
        } catch {}
      }
      if (t) {
        try {
          t.disconnect();
        } catch {}
      }
    }, 0);
}

startBtn.onclick = start;
hangupBtn.onclick = () => {
  userHungUp = true;
  if (route.value === "sip") {
    endSip("hung up", "info");
    return;
  }
  if (player) player.port.postMessage("clear");
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "hangup" }));
  else stop("call ended");
};
