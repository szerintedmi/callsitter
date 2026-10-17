// Owner takeover page: a Telegram Mini App, or (body data-mode="admin") a tab the admin call page
// opens, signed in by Cloudflare Access instead of Telegram. See src/web/takeover.ts for the protocol.
// Audio goes through the test-call page's worklet: mic → 16 kHz PCM16 20 ms frames, and its
// jitter-buffered player for the caller.

import { wsUrl } from "./ws";

// The parts of Telegram's WebApp script (https://core.telegram.org/bots/webapps) this page uses.
interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(v: string): boolean;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  disableVerticalSwipes(): void;
}
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

type ServerMsg =
  | { type: "connecting" }
  | { type: "live" }
  | { type: "ended"; reason: string }
  | { type: "error"; message: string }
  | { type: "resume"; token: string };

/** how long to keep reconnecting a dropped socket (the server waits takeover.reconnect_grace_ms) */
const RECONNECT_FOR_MS = 8000;
/** how often the page sends its audio counters while live */
const STATS_EVERY_MS = 10_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Same ?v= build tag as this script, so the worklet is never a stale cached copy either.
const V = (document.currentScript as HTMLScriptElement | null)?.src.split("?")[1] || "";
const statusEl = $("status"), timerEl = $("timer"), hintEl = $("hint"), controls = $("controls");
const startBtn = $<HTMLButtonElement>("start"), muteBtn = $<HTMLButtonElement>("mute"), hangupBtn = $<HTMLButtonElement>("hangup");
// Telegram: /takeover/<id>, socket /takeover/ws/<id>; admin: /calls/<id>/takeover, socket …/ws.
const admin = document.body?.dataset.mode === "admin";
const parts = location.pathname.split("/").filter(Boolean);
const callId = decodeURIComponent((admin ? parts[1] : parts.pop()) || "");
const wsPath = admin ? `/calls/${encodeURIComponent(callId)}/takeover/ws` : "/takeover/ws/" + encodeURIComponent(callId);
const tg = admin ? undefined : window.Telegram?.WebApp;

let stream: MediaStream | null = null, ctx: AudioContext | null = null, player: AudioWorkletNode | null = null;
let ws: WebSocket | null = null, liveAt = 0, timer: ReturnType<typeof setInterval> | null = null;
let done = false, droppedAt = 0, upLast = 0, upPos = 0;
/** sent on a reconnect: Telegram's initData goes stale long before a call ends (admin: keeps the takeover's resume) */
let resume = "";
/** audio counters for the server's takeover stats line (OwnerPageStats); mutedSince is 0 unless muted */
const stats = { sentFrames: 0, underruns: 0, mutedMs: 0 };
let mutedSince = 0;

function sendStats() {
  if (!ws || ws.readyState !== 1) return;
  const mutedMs = stats.mutedMs + (mutedSince ? Date.now() - mutedSince : 0);
  ws.send(JSON.stringify({ type: "stats", ...stats, mutedMs }));
}

const status = (s: string) => (statusEl.textContent = s);
const errText = (err: any) => String(err && err.message ? err.message : err);

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

function showTimer() {
  const s = Math.floor((Date.now() - liveAt) / 1000);
  timerEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** Mic and audio graph, set up once on the first tap (Android re-prompts per getUserMedia call). */
async function startAudio() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/assets/test-call-worklet.js" + (V ? "?" + V : ""));
  const capture = new AudioWorkletNode(ctx, "capture");
  const silent = ctx.createGain();
  silent.gain.value = 0; // keeps the capture node pulled by the graph without playing the mic back
  ctx.createMediaStreamSource(stream).connect(capture).connect(silent).connect(ctx.destination);
  player = new AudioWorkletNode(ctx, "player", { outputChannelCount: [1] });
  player.connect(ctx.destination);
  player.port.onmessage = (e) => {
    if (e.data === "underrun") stats.underruns++;
  };
  capture.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer }>) => {
    if (!ws || ws.readyState !== 1 || !liveAt) return;
    ws.send(e.data.pcm); // raw PCM16LE, 20 ms
    stats.sentFrames++;
  };
}

function connect() {
  const sock = (ws = new WebSocket(wsUrl(wsPath)));
  sock.binaryType = "arraybuffer";
  sock.onopen = () => sock.send(JSON.stringify({ type: "hello", ...(tg ? { initData: tg.initData } : {}), ...(resume ? { resume } : {}) }));
  sock.onmessage = (m) => {
    if (typeof m.data !== "string") {
      if (!ctx || !player) return;
      const f = upsample(new Int16Array(m.data as ArrayBuffer), ctx.sampleRate);
      player.port.postMessage(f, [f.buffer]);
      return;
    }
    const msg = JSON.parse(m.data) as ServerMsg;
    if (msg.type === "resume") return void (resume = msg.token);
    droppedAt = 0;
    if (msg.type === "connecting") status(liveAt ? "Reconnecting…" : "Connecting to the caller…");
    else if (msg.type === "live") {
      status("Live: you're talking to the caller");
      if (!liveAt) {
        liveAt = Date.now();
        timerEl.hidden = false;
        showTimer();
        timer = setInterval(showTimer, 1000);
        setInterval(() => !done && sendStats(), STATS_EVERY_MS);
      }
      controls.hidden = false;
      hangupBtn.disabled = false;
    } else if (msg.type === "ended") end("Call ended" + (msg.reason ? ": " + msg.reason : ""));
    else if (msg.type === "error") end(msg.message);
  };
  sock.onclose = () => {
    if (ws !== sock || done) return;
    ws = null;
    // Dropped (network, app in the background): the server holds the call for a few seconds.
    if (!droppedAt) droppedAt = Date.now();
    if (Date.now() - droppedAt > RECONNECT_FOR_MS) return end("Connection lost");
    status("Connection lost: reconnecting…");
    setTimeout(() => !done && connect(), 1000);
  };
}

async function start() {
  startBtn.disabled = true;
  try {
    status("Allow the microphone…");
    await startAudio();
    status("Connecting…");
    startBtn.hidden = true;
    controls.hidden = false;
    hangupBtn.disabled = false;
    connect();
  } catch (err) {
    startBtn.disabled = false;
    status("Could not start: " + errText(err));
  }
}

/** The call is over for this page: stop the mic and audio, close the socket. */
function end(msg: string) {
  if (done) return;
  done = true;
  status(msg);
  if (timer) clearInterval(timer);
  controls.hidden = true;
  hintEl.hidden = true;
  const sock = ws;
  ws = null;
  if (sock && sock.readyState <= 1) sock.close();
  stream?.getTracks().forEach((t) => t.stop());
  if (ctx && ctx.state !== "closed") void ctx.close();
  try {
    tg?.disableClosingConfirmation();
  } catch {}
}

if (!admin && (!tg || !tg.initData)) {
  // A plain browser (or a link shared out of Telegram): nothing to authenticate with.
  status("Open this from the Telegram button.");
  hintEl.hidden = true;
} else {
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.isVersionAtLeast("6.2")) tg.enableClosingConfirmation();
    if (tg.isVersionAtLeast("7.7")) tg.disableVerticalSwipes();
  } else {
    // Closing the tab is the owner leaving (the call hangs up): ask first, as Telegram does.
    window.addEventListener("beforeunload", (e) => {
      if (ws && !done) e.preventDefault();
    });
  }
  startBtn.hidden = false;
  startBtn.onclick = () => void start();
  muteBtn.onclick = () => {
    const muted = muteBtn.getAttribute("aria-pressed") !== "true";
    stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (!muted && mutedSince) stats.mutedMs += Date.now() - mutedSince;
    mutedSince = muted ? Date.now() : 0;
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.textContent = muted ? "Unmute" : "Mute";
  };
  hangupBtn.onclick = () => {
    hangupBtn.disabled = true;
    player?.port.postMessage("clear");
    if (ws && ws.readyState === 1) {
      sendStats();
      ws.send(JSON.stringify({ type: "hangup" }));
      status("Hanging up…");
      // The server answers with {type:"ended"}; don't wait on it forever.
      setTimeout(() => end("Call ended"), 3000);
    } else end("Call ended");
  };
}
