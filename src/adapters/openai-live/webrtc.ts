import OpenAI from "openai";
import type { VoiceAgent, VoiceSession, VoiceSessionHandlers, VoiceSessionOptions } from "../../core/ports";
import { liveInstructions } from "./session";
import { hangupSession, recordedSideband } from "./sip";

// OpenAI Live over WebRTC for the public page
// (https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): "Your browser creates
// a Session Description Protocol (SDP) offer. Your application server exchanges it for an
// answer with POST /v1/live/sessions". The key and the prompt stay here; the browser's audio
// goes straight to OpenAI, and we attach a sideband exactly as for a SIP call.

export interface OpenAiWebRtcOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseURL?: string;
  /** sideband base URL (tests) */
  liveUrl?: string;
}

export interface WebRtcAnswer {
  sessionId: string;
  sdp: string;
}

export class OpenAiWebRtc {
  private client: OpenAI;

  constructor(private o: OpenAiWebRtcOptions) {
    this.client = new OpenAI({ apiKey: o.apiKey, fetch: o.fetch, baseURL: o.baseURL, maxRetries: 1 });
  }

  /**
   * A voice agent for one browser offer: connect() creates the session with the Live config,
   * attaches the sideband and only then hands the SDP answer to `onAnswer` (the page is waiting
   * for it): without the sideband nothing limits the call, so the page must not connect.
   */
  voiceAgent(
    offerSdp: string,
    opts: { onAnswer: (a: WebRtcAnswer) => void; onRecording?: (wav: ArrayBuffer) => void; greetAfter?: Promise<void> },
  ): VoiceAgent {
    return {
      connect: async (o: VoiceSessionOptions, h: VoiceSessionHandlers): Promise<VoiceSession> => {
        const res = await this.client.live.create(
          {
            session: {
              model: o.config.model,
              instructions: liveInstructions(o),
              audio: { output: { voice: o.config.voice } },
              delegation: { type: "client" },
              store: false,
              // The page is untrusted: it may not steer the agent, and it only hears when the
              // session closes. The sideband is unaffected.
              client: { data_channel: { allowed_client_events: [], allowed_server_events: [{ type: "session.closed" }] } },
            },
            transport: { type: "webrtc", sdp: offerSdp },
          },
          { signal: o.signal },
        );
        const sessionId = res.session.id;
        // The page's connection outlives the sideband unless we end the session too: hang up
        // whenever the sideband closes, or doesn't attach.
        let hungUp = false;
        const hangup = () => {
          if (hungUp) return;
          hungUp = true;
          hangupSession(this.client, sessionId).catch((err) =>
            console.warn(`[live ${sessionId}] hangup failed: ${err instanceof Error ? err.message : err}`),
          );
        };
        let session: VoiceSession;
        try {
          session = await recordedSideband(this.o.apiKey, this.o.liveUrl, sessionId, o, { ...h, onClose: () => (hangup(), h.onClose()) }, opts);
        } catch (err) {
          hangup();
          throw err;
        }
        opts.onAnswer({ sessionId, sdp: res.transport.sdp });
        return session;
      },
    };
  }
}
