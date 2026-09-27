// One call from the public page (public.ts draws it): WebRTC straight to OpenAI Live. The server
// swaps the SDP and steers the call; this sends the mic, plays the agent, and passes on what the
// server streams. No imports, so test/public-client.test.ts can run it against fakes.

/** What the server streams during a call (src/core/game.ts PlayState). Times: ms since call start. */
export interface PlayState {
  verdict: string | null;
  lean: number;
  stage: string | null;
  caughtAt: number | null;
  /** when the referee says the caller tried the scam (scam) or passed on their message */
  goalAt: number | null;
}

export interface DialOptions {
  base: string;
  /** sent with the SDP offer (POST call) */
  game: { game: string; goal: string; player: string };
  remote: HTMLAudioElement;
  /** the agent's greeting is playing (or the page can't tell and waited long enough) */
  onLive(): void;
  onState(s: PlayState): void;
  /** the call is over; `live`: it got that far. `text` says why, for the visitor ("" if they hung up) */
  onEnd(end: { live: boolean; text: string; callId: string | null }): void;
}

export interface Call {
  /** the server's call id, once it answered */
  id: string | null;
  /** Date.now() at the server's call start (event times count from it) */
  t0: number;
  hangUp(): void;
}

/** WebRTC must connect within this long of the answer */
const CONNECT_TIMEOUT_MS = 15000;
/** a "disconnected" peer connection that doesn't recover within this long has ended */
const DISCONNECT_GRACE_MS = 4000;
/** after WebRTC connects, go live within this long even if the page can't hear the greeting */
const GREETING_TIMEOUT_MS = 6000;
/** agent loudness (0..1, see level()) that counts as its greeting playing */
const SPEECH_LEVEL = 0.1;

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

/** Starts a call; everything after comes through the callbacks. */
export function dial(o: DialOptions): Call {
  let ended = false;
  let live = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let pc: RTCPeerConnection | null = null;
  let agent: AnalyserNode | null = null;
  let events: EventSource | null = null;
  let wake: WakeLockSentinel | null = null;
  /** stops the connecting cues (ringback, greeting poll); null once live or ended */
  let connecting: (() => void) | null = null;
  const call: Call = { id: null, t0: Date.now(), hangUp: () => end("", true) };

  /** The agent's greeting is actually playing on this page. */
  const heard = () =>
    pc?.connectionState === "connected" && ctx?.state === "running" && !o.remote.paused && level(agent) > SPEECH_LEVEL;

  function goLive() {
    if (ended || !connecting) return;
    connecting();
    connecting = null;
    live = true;
    o.onLive();
  }

  /** Ends the call on the page (and on the server, unless the server ended it). */
  function end(text: string, tellServer = false) {
    if (ended) return;
    ended = true;
    connecting?.();
    connecting = null;
    if (tellServer && call.id) navigator.sendBeacon(`${o.base}call/${call.id}/hangup`);
    timers.forEach(clearTimeout);
    events?.close();
    stream?.getTracks().forEach((t) => t.stop());
    pc?.close();
    void ctx?.close().catch(() => {});
    void wake?.release().catch(() => {});
    o.remote.srcObject = null;
    o.onEnd({ live, text, callId: call.id });
  }

  const post = (path: string, body?: unknown) =>
    fetch(o.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (ended) return void stream.getTracks().forEach((t) => t.stop());
      const c = (ctx = new AudioContext());
      void c.resume();
      const peer = (pc = new RTCPeerConnection());
      // WebRTC often connects seconds before the greeting arrives, so stay "connecting" until it
      // plays. Polled on a timer rather than per frame, so it also ends in a background tab.
      const stopRinging = ringback(c);
      const listen = setInterval(() => heard() && goLive(), 100);
      connecting = () => { clearInterval(listen); stopRinging(); };
      stream.getTracks().forEach((t) => peer.addTrack(t, stream!));
      peer.ontrack = (e) => {
        const s = e.streams[0] ?? new MediaStream([e.track]);
        o.remote.srcObject = s;
        void o.remote.play().catch(() => {});
        // Not connected to the output: the agent plays through the <audio> element (which also
        // keeps Chrome's remote WebRTC stream flowing into Web Audio).
        const a = c.createAnalyser();
        a.fftSize = 512;
        c.createMediaStreamSource(s).connect(a);
        agent = a;
      };
      // The session only tells the page when it closes (the call ended on the server's side).
      const dc = peer.createDataChannel("oai-events");
      dc.onmessage = (e) => {
        try {
          if (JSON.parse(String(e.data)).type === "session.closed") end("Call ended.");
        } catch {}
      };
      peer.onconnectionstatechange = () => {
        if (ended) return;
        const st = peer.connectionState;
        if (st === "connected") {
          if (call.id) void post(`call/${call.id}/connected`);
          // Go live anyway if the page can't hear the greeting (autoplay blocked, a suspended AudioContext).
          timers.push(setTimeout(goLive, GREETING_TIMEOUT_MS));
        } else if (st === "failed" || st === "closed") end("Call ended.");
        else if (st === "disconnected") {
          timers.push(setTimeout(() => peer.connectionState === "disconnected" && end("Call dropped."), DISCONNECT_GRACE_MS));
        }
      };
      navigator.wakeLock?.request("screen").then((w) => (ended ? void w.release() : (wake = w)), () => {});

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const r = await post("call", { sdp: offer.sdp, ...o.game });
      const j = (await r.json().catch(() => ({}))) as { callId?: string; sdp?: string; elapsedMs?: number; message?: string };
      if (ended) return; // hung up meanwhile
      if (!r.ok || !j.callId || !j.sdp) return end(j.message || "Couldn't connect. Try again.");
      call.id = j.callId;
      call.t0 = Date.now() - (j.elapsedMs ?? 0);
      const es = (events = new EventSource(`${o.base}call/${j.callId}/events`));
      es.onmessage = (e) => !ended && o.onState(JSON.parse(e.data) as PlayState);
      // The call is over: don't let EventSource reconnect to a call that's gone.
      es.addEventListener("ended", () => es.close());
      await peer.setRemoteDescription({ type: "answer", sdp: j.sdp });
      timers.push(setTimeout(() => peer.connectionState !== "connected" && end("Couldn't connect. Try again."), CONNECT_TIMEOUT_MS));
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      end(denied ? "Needs your microphone." : "Couldn't connect. Try again.");
    }
  })();
  return call;
}
