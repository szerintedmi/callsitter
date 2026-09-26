// The public "Scam me" page (src/web/public.ts): WebRTC straight to OpenAI Live. The server swaps
// the SDP and steers the call; this page only sends the mic, plays the agent and draws one orb
// (outline: your voice, fill: the agent's).

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cta = $("cta"), go = $<HTMLButtonElement>("go"), end = $<HTMLButtonElement>("end"), orb = $("orb"), msg = $("msg");
const remote = $<HTMLAudioElement>("remote");
const me = orb.querySelector<HTMLElement>(".me")!, it = orb.querySelector<HTMLElement>(".it")!;
const jev = $("jev"), needle = $("needle"), stageEl = $("stage");
const base = document.body.dataset.base || "/";
/** WebRTC must connect within this long of the answer */
const CONNECT_TIMEOUT_MS = 15000;
/** a "disconnected" peer connection that doesn't recover within this long has ended */
const DISCONNECT_GRACE_MS = 4000;
/** after WebRTC connects, go live within this long even if the page can't hear the greeting */
const GREETING_TIMEOUT_MS = 6000;
/** agent loudness (0..1, see level()) that counts as its greeting playing */
const SPEECH_LEVEL = 0.1;

type Call = {
  id: string | null;
  pc: RTCPeerConnection;
  stream: MediaStream;
  ctx: AudioContext;
  mic: AnalyserNode;
  agent: AnalyserNode | null;
  timers: ReturnType<typeof setTimeout>[];
  frame: number;
  wake: WakeLockSentinel | null;
  events: EventSource | null;
  /** stops the connecting cues (ringback, greeting poll); null once live or ended */
  connecting: (() => void) | null;
};
/** What the server says about the call (src/web/public.ts → PublicState). */
type JevState = { verdict: string | null; lean: number; stage: string | null };
let call: Call | null = null;

function show(state: "idle" | "connecting" | "live", text = "") {
  document.body.className = state;
  cta.hidden = state !== "idle";
  orb.hidden = state === "idle";
  end.hidden = state === "idle";
  jev.hidden = state !== "live";
  msg.textContent = text;
}

/** The needle shows genuine (left) to scam/spam (right); the single label shows the call stage. */
function showJev(s: JevState) {
  needle.style.transform = `rotate(${Math.round(s.lean * 90)}deg)`;
  stageEl.textContent = s.stage ?? "";
}

function resetJev() {
  showJev({ verdict: null, lean: 0, stage: null });
}

function analyser(ctx: AudioContext, stream: MediaStream) {
  const a = ctx.createAnalyser();
  a.fftSize = 512;
  // Not connected to the output: the agent plays through the <audio> element (which also keeps
  // Chrome's remote WebRTC stream flowing into Web Audio), and the mic mustn't play back.
  ctx.createMediaStreamSource(stream).connect(a);
  return a;
}

/** Quiet double-ring, played locally and never mixed into the outgoing mic stream. */
function ringback(ctx: AudioContext) {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(out);
  const tones = [440, 480].map((frequency) => {
    const tone = ctx.createOscillator();
    tone.frequency.value = frequency;
    tone.connect(gain);
    tone.start();
    tone.onended = () => { tone.disconnect(); gain.disconnect(); out.disconnect(); };
    return tone;
  });
  const ring = () => {
    const start = ctx.currentTime + 0.02;
    for (const offset of [0, 0.6]) {
      const at = start + offset;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.025, at + 0.025);
      gain.gain.setValueAtTime(0.025, at + 0.375);
      gain.gain.linearRampToValueAtTime(0, at + 0.4);
    }
  };
  ring();
  const timer = setInterval(ring, 3000);
  return () => {
    clearInterval(timer);
    // Fade the output: cancelling the ring's own automation mid-ramp can click.
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    tones.forEach((tone) => tone.stop(ctx.currentTime + 0.03));
  };
}

const buf = new Float32Array(512);
/** 0..1 loudness of the last analyser frame (RMS, eased so quiet speech still shows) */
function level(a: AnalyserNode | null) {
  if (!a) return 0;
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length) * 5));
}

let micLevel = 0, agentLevel = 0;
function draw() {
  if (!call) return;
  // Fast attack, slow release, so the orb breathes rather than flickers.
  const ease = (prev: number, next: number) => (next > prev ? prev + (next - prev) * 0.5 : prev + (next - prev) * 0.12);
  micLevel = ease(micLevel, level(call.mic));
  agentLevel = ease(agentLevel, level(call.agent));
  if (document.body.className === "live") {
    me.style.transform = `scale(${0.62 + micLevel * 0.38})`;
    me.style.opacity = String(0.3 + micLevel * 0.7);
    it.style.transform = `scale(${0.18 + agentLevel * 0.62})`;
  }
  call.frame = requestAnimationFrame(draw);
}

/** The agent's greeting is actually playing on this page. */
function heard(c: Call) {
  return c.pc.connectionState === "connected" && c.ctx.state === "running" && !remote.paused && level(c.agent) > SPEECH_LEVEL;
}

/** Ends the connecting cues and shows the call as live. */
function goLive(c: Call) {
  if (call !== c || !c.connecting) return;
  c.connecting();
  c.connecting = null;
  show("live");
}

async function start() {
  // Visually just the orb; the text is for screen readers (#msg is a status region).
  show("connecting", "Connecting…");
  let c: Call | null = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext();
    void ctx.resume();
    const pc = new RTCPeerConnection();
    c = call = { id: null, pc, stream, ctx, mic: analyser(ctx, stream), agent: null, timers: [], frame: 0, wake: null, events: null, connecting: null };
    const mine = c;
    // WebRTC often connects seconds before the greeting arrives, so stay "connecting" until it
    // plays. Polled on a timer rather than per frame, so it also ends in a background tab.
    const stopRinging = ringback(ctx);
    const listen = setInterval(() => heard(mine) && goLive(mine), 100);
    mine.connecting = () => { clearInterval(listen); stopRinging(); };
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track]);
      remote.srcObject = s;
      void remote.play().catch(() => {});
      if (call === mine) mine.agent = analyser(ctx, s);
    };
    // The session only tells the page when it closes (the call ended on the server's side).
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = (e) => {
      try {
        if (JSON.parse(String(e.data)).type === "session.closed") finish(mine, "Call ended.");
      } catch {}
    };
    pc.onconnectionstatechange = () => {
      if (call !== mine) return;
      const st = pc.connectionState;
      if (st === "connected") {
        if (mine.id) void post(`call/${mine.id}/connected`);
        // Go live anyway if the page can't hear the greeting (autoplay blocked, a suspended AudioContext).
        mine.timers.push(setTimeout(() => goLive(mine), GREETING_TIMEOUT_MS));
      } else if (st === "failed" || st === "closed") finish(mine, "Call ended.");
      else if (st === "disconnected") {
        mine.timers.push(setTimeout(() => pc.connectionState === "disconnected" && finish(mine, "Call dropped."), DISCONNECT_GRACE_MS));
      }
    };
    draw();
    navigator.wakeLock?.request("screen").then((w) => (call === mine ? (mine.wake = w) : void w.release()), () => {});

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await post("call", { sdp: offer.sdp });
    const j = (await r.json().catch(() => ({}))) as { callId?: string; sdp?: string; message?: string };
    if (call !== mine) return; // hung up meanwhile
    if (!r.ok || !j.callId || !j.sdp) return finish(mine, j.message || "Couldn't connect. Try again.");
    mine.id = j.callId;
    const events = (mine.events = new EventSource(`${base}call/${j.callId}/events`));
    events.onmessage = (e) => call === mine && showJev(JSON.parse(e.data) as JevState);
    // The call is over: don't let EventSource reconnect to a call that's gone.
    events.addEventListener("ended", () => events.close());
    await pc.setRemoteDescription({ type: "answer", sdp: j.sdp });
    mine.timers.push(setTimeout(() => pc.connectionState !== "connected" && finish(mine, "Couldn't connect. Try again."), CONNECT_TIMEOUT_MS));
  } catch (err) {
    const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
    const text = denied ? "Needs your microphone." : "Couldn't connect. Try again.";
    if (c) finish(c, text);
    else show("idle", text);
  }
}

function post(path: string, body?: unknown) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

/** Ends `c` on the page (and on the server, unless the server ended it). */
function finish(c: Call, text: string, tellServer = false) {
  if (call !== c) return;
  call = null;
  c.connecting?.();
  c.connecting = null;
  if (tellServer && c.id) navigator.sendBeacon(`${base}call/${c.id}/hangup`);
  c.timers.forEach(clearTimeout);
  c.events?.close();
  resetJev();
  cancelAnimationFrame(c.frame);
  c.stream.getTracks().forEach((t) => t.stop());
  c.pc.close();
  void c.ctx.close().catch(() => {});
  void c.wake?.release().catch(() => {});
  remote.srcObject = null;
  micLevel = agentLevel = 0;
  me.style.transform = it.style.transform = me.style.opacity = "";
  show("idle", text);
}

go.onclick = () => void start();
end.onclick = () => call && finish(call, "", true);
// Closing the tab or leaving the page hangs up too (the server would only notice later).
addEventListener("pagehide", () => call && finish(call, "", true));
