import type { ClientEvent, ServerEvent } from "openai/resources/live/live";
import type { AudioFormat } from "../../core/audio";
import type { LiveAppend } from "../../core/config";
import { b64decode } from "../../core/audio";
import type { VoiceAgent, VoiceSession, VoiceSessionHandlers, VoiceSessionOptions } from "../../core/ports";
import type { StereoRecorder } from "../../core/wav";
import { TranscriptSegmenter } from "./segmenter";

// OpenAI Live (gpt-live-1) over a primary WebSocket, or as a sideband on a SIP session. Docs:
//   https://developers.openai.com/api/docs/guides/voice-websockets?api=live
//   https://developers.openai.com/api/docs/guides/voice-server-controls?api=live (sideband)
//   https://developers.openai.com/api/docs/guides/live-delegation
// The SDK's LiveWS needs the `ws` package, so this uses Bun's WebSocket and only the SDK types.

export const LIVE_URL = "wss://api.openai.com/v1/live/sessions";

const APPEND_EVENT = {
  instructions: "session.instructions.append",
  thinking: "session.thinking.append",
  commentary: "session.commentary.append",
} as const satisfies Record<LiveAppend, ClientEvent["type"]>;

/** Live's session audio format: G.711 passes through, L16/PCM is little-endian PCM16. */
const LIVE_FORMAT = {
  pcmu: { type: "audio/pcmu", rate: 8000 },
  pcma: { type: "audio/pcma", rate: 8000 },
  l16: { type: "audio/pcm", rate: 16000 },
  pcm24: { type: "audio/pcm", rate: 24000 },
} as const satisfies Record<AudioFormat, { type: string; rate: number }>;

/** Frontend prompt: the Live instructions ({owner_name} is filled in when the config loads). */
export function liveInstructions(o: VoiceSessionOptions): string {
  return o.config.instructions;
}

export class OpenAiLiveAgent implements VoiceAgent {
  constructor(private opts: { apiKey: string; url?: string }) {}

  connect(o: VoiceSessionOptions, h: VoiceSessionHandlers): Promise<VoiceSession> {
    return LiveSession.open(this.opts.url ?? LIVE_URL, this.opts.apiKey, o, h, {
      start: {
        type: "session.start",
        session: {
          model: o.config.model,
          instructions: liveInstructions(o),
          audio: {
            format: LIVE_FORMAT[o.codec],
            output: { voice: o.config.voice },
          },
          delegation: { type: "client" },
          // A recorded greeting was already played: Live continues from it.
          ...(o.greeted
            ? { input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: o.greeted }] }] }
            : {}),
          store: false,
        },
      },
    });
  }
}

export interface SidebandOptions {
  /** records the reflected caller and agent audio (24 kHz PCM16LE) */
  recorder?: StereoRecorder;
  /** say the greeting only once this resolves (e.g. the caller's leg can play audio) */
  greetAfter?: Promise<void>;
}

/**
 * Attaches to an already-started Live session (an accepted SIP call) as a sideband. The call's
 * audio flows between the carrier and OpenAI; the sideband gets transcripts, delegation events
 * and reflected copies of both audio directions, and can append instructions.
 */
export function attachSideband(
  url: string,
  apiKey: string,
  o: VoiceSessionOptions,
  h: VoiceSessionHandlers,
  opts: SidebandOptions = {},
): Promise<VoiceSession> {
  return LiveSession.open(url, apiKey, o, h, { recorder: opts.recorder, greetAfter: opts.greetAfter });
}

interface OpenOptions {
  /** primary connection: session.start to send on open. Absent for a sideband (already started). */
  start?: ClientEvent;
  recorder?: StereoRecorder;
  greetAfter?: Promise<void>;
}

class LiveSession implements VoiceSession {
  private started = false;
  private closed = false;
  private closing = false;
  /** commands sent before session.started are queued (docs: wait for session.started) */
  private pending: ClientEvent[] = [];
  private segmenter: TranscriptSegmenter;
  private sweep: ReturnType<typeof setInterval>;
  private markClosed!: () => void;
  /** resolves once the socket is gone and onClose has run */
  private readonly whenClosed = new Promise<void>((r) => (this.markClosed = r));

  private constructor(
    private ws: WebSocket,
    private h: VoiceSessionHandlers,
    private sideband: boolean,
    private recorder?: StereoRecorder,
  ) {
    this.segmenter = new TranscriptSegmenter({
      delta: (s, id, d) => h.onTranscriptDelta(s, id, d),
      done: (s, id) => h.onTranscriptDone(s, id),
    });
    this.sweep = setInterval(() => this.segmenter.sweep(), 300);
  }

  static open(url: string, apiKey: string, o: VoiceSessionOptions, h: VoiceSessionHandlers, oo: OpenOptions): Promise<LiveSession> {
    return new Promise((resolve, reject) => {
      if (o.signal?.aborted) return reject(abortReason(o.signal));
      // No permessage-deflate: Bun offers it by default, and compressing every 20 ms audio frame
      // adds latency (yapware's LiveWS sets perMessageDeflate: false for the same reason).
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` }, perMessageDeflate: false });
      const s = new LiveSession(ws, h, !oo.start, oo.recorder);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return h.onError(err);
        settled = true;
        s.shutdown();
        reject(err);
      };
      const ready = () => {
        settled = true;
        s.onStarted(o.greeted ? null : o.config.greeting, oo.greetAfter);
        resolve(s);
      };

      // The call ended, or the caller gave up waiting: stop connecting.
      o.signal?.addEventListener("abort", () => settled || fail(abortReason(o.signal!)), { once: true });

      ws.onopen = () => {
        // A sideband attaches to a session that has started already ("do not resend session.start").
        if (oo.start) s.raw(oo.start);
        else ready();
      };
      ws.onmessage = (m) => {
        let ev: ServerEvent;
        try {
          ev = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
        } catch {
          return;
        }
        if (ev.type === "session.started" && !settled) return ready();
        if (ev.type === "error" && !settled) return fail(new Error(`Live: ${ev.error.code}: ${ev.error.message}`));
        s.onEvent(ev);
      };
      ws.onerror = () => fail(new Error("Live WebSocket error"));
      ws.onclose = (e) => {
        if (!settled) fail(new Error(`Live WebSocket closed before start (${e.code} ${e.reason})`));
        // Without session.closed, the close code is all there is to say why the call ended.
        else if (!s.closed && !s.closing) h.onError(new Error(`Live WebSocket closed without session.closed (${e.code} ${e.reason})`));
        s.shutdown();
      };
    });
  }

  /**
   * `greeting`: what to say first, or null when a recorded greeting was already played.
   * `greetAfter`: hold the greeting until it resolves; other instructions aren't held.
   */
  private onStarted(greeting: string | null, greetAfter?: Promise<void>) {
    this.started = true;
    // There is no response-trigger event; the docs' way to make the agent speak first is an
    // instructions.append (https://developers.openai.com/api/docs/guides/live-prompting).
    if (greeting) {
      const greet = () =>
        this.send({
          type: "session.instructions.append",
          delegation_id: null,
          content: `The phone has just been answered. Speak first: say "${greeting}" and then listen.`,
        });
      if (greetAfter) void greetAfter.then(greet);
      else greet();
    }
    for (const ev of this.pending.splice(0)) this.raw(ev);
  }

  private onEvent(ev: ServerEvent) {
    switch (ev.type) {
      case "session.output_audio.delta":
        // Sideband copies carry start_ms on the session timeline; dropped frames leave gaps.
        if (this.recorder && ev.start_ms !== undefined) this.recorder.addAgentAt(b64decode(ev.delta), ev.start_ms);
        this.h.onAudio(ev.delta);
        break;
      case "session.input_audio.append":
        // Caller audio reflected to the sideband (no timestamps: it streams continuously).
        this.recorder?.addCaller(b64decode(ev.audio));
        this.h.onCallerAudio?.(ev.audio);
        break;
      case "session.input_transcript.delta":
        this.segmenter.push("caller", ev.delta, ev.start_ms, ev.end_ms);
        break;
      case "session.output_transcript.delta":
        this.segmenter.push("agent", ev.delta, ev.start_ms, ev.end_ms);
        break;
      case "session.usage.updated":
        this.h.onUsage?.({ seconds: ev.usage.seconds, contextRatio: ev.context_window?.usage_ratio });
        break;
      case "session.delegation.created":
        if (ev.delegation.target === "client") this.h.onDelegation({ id: ev.delegation.id });
        break;
      case "error":
        // Appends still queued when we close report context_injection_incomplete; that's
        // expected at hangup, not a failure.
        if (this.closing && ev.error.code === "context_injection_incomplete") break;
        this.h.onError(new Error(`Live: ${ev.error.code}: ${ev.error.message}`));
        break;
      case "session.closed":
        this.shutdown(ev.reason);
        break;
    }
  }

  private raw(ev: ClientEvent) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private send(ev: ClientEvent) {
    if (this.closed || this.closing) return;
    if (this.started) this.raw(ev);
    else this.pending.push(ev);
  }

  sendAudio(payloadB64: string) {
    // A sideband can't send audio: it flows over the SIP leg.
    if (this.sideband) return;
    // Audio before session.started is dropped rather than queued; it is only ringing/silence.
    if (this.started && !this.closed && !this.closing) this.raw({ type: "session.input_audio.append", audio: payloadB64 });
  }

  append(as: LiveAppend, text: string, delegationId?: string) {
    this.send({ type: APPEND_EVENT[as], delegation_id: delegationId ?? null, content: text });
  }

  close(): Promise<void> {
    if (this.closed || this.closing) return this.whenClosed;
    this.closing = true;
    this.raw({ type: "session.close" });
    // Give the server a moment to send session.closed, then drop the socket.
    setTimeout(() => this.shutdown(), 2000);
    return this.whenClosed;
  }

  private shutdown(reason?: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweep);
    this.segmenter.flush();
    try {
      this.ws.close();
    } catch {}
    try {
      this.h.onClose(reason);
    } finally {
      this.markClosed();
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Live connection aborted");
}
