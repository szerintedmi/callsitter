import OpenAI from "openai";
import type { UnwrapWebhookEvent } from "openai/resources/webhooks/webhooks";
import type { VoiceAgent, VoiceSession, VoiceSessionHandlers, VoiceSessionOptions } from "../../core/ports";
import { StereoRecorder } from "../../core/wav";
import { attachSideband, LIVE_URL, liveInstructions } from "./session";

// OpenAI Live over SIP (https://developers.openai.com/api/docs/guides/voice-sip?api=live):
// the carrier sends the call to sip:$PROJECT_ID@sip.api.openai.com;transport=tls, OpenAI
// posts a signed `live.transport.incoming` webhook, we accept it with the session config and
// attach a sideband WebSocket for transcripts, steering and reflected audio.

export const SIP_HOSTS = { global: "sip.api.openai.com", eu: "sip-eu.api.openai.com" } as const;

export function sipUri(projectId: string, region: keyof typeof SIP_HOSTS): string {
  return `sip:${projectId}@${SIP_HOSTS[region]};transport=tls`;
}

export interface SipHeader {
  name: string;
  value: string;
}

export interface SipIncoming {
  sessionId: string;
  sipHeaders: SipHeader[];
}

export function sipHeader(headers: readonly SipHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** The user part of a From/To header, e.g. `"Bob" <sip:+447700900123@host>;tag=1` → `+447700900123`. */
export function sipUser(value: string | undefined): string | undefined {
  const m = value?.match(/(?:sips?|tel):([^@;>]+)/i);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

export interface OpenAiSipOptions {
  apiKey: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  baseURL?: string;
  /** sideband base URL (tests) */
  liveUrl?: string;
}

export class OpenAiSip {
  private client: OpenAI;

  constructor(private o: OpenAiSipOptions) {
    this.client = new OpenAI({ apiKey: o.apiKey, webhookSecret: o.webhookSecret, fetch: o.fetch, baseURL: o.baseURL, maxRetries: 1 });
  }

  /** Verifies the signature (Standard Webhooks, 5-minute tolerance) and parses the event; throws if invalid. */
  unwrap(raw: string, headers: Headers): Promise<UnwrapWebhookEvent> {
    return this.client.webhooks.unwrap(raw, headers);
  }

  /** `sessionId` is the webhook's `live_…` id, passed unchanged. */
  reject(sessionId: string, statusCode: number) {
    return this.client.live.sessions.reject(sessionId, { status_code: statusCode });
  }

  async hangup(sessionId: string) {
    try {
      await this.client.live.sessions.hangup(sessionId);
    } catch (err) {
      // The call has ended already.
      if (err instanceof OpenAI.APIError && (err.status === 404 || err.status === 409)) return;
      throw err;
    }
  }

  /**
   * A voice agent for one incoming SIP session: connect() accepts the call with the Live config
   * (SIP negotiates the audio format, so there is none) and attaches the sideband. With
   * `onRecording`, the reflected audio is recorded as a stereo 24 kHz WAV (caller left, agent
   * right) and handed over when the session closes. With `greetAfter`, the greeting waits for it.
   */
  voiceAgent(sessionId: string, opts: { onRecording?: (wav: ArrayBuffer) => void; greetAfter?: Promise<void> } = {}): VoiceAgent {
    return {
      connect: async (o: VoiceSessionOptions, h: VoiceSessionHandlers): Promise<VoiceSession> => {
        await this.client.live.sessions.accept(
          sessionId,
          {
            session: {
              type: "live",
              model: o.config.model,
              instructions: liveInstructions(o),
              audio: { output: { voice: o.config.voice } },
              delegation: { type: "client" },
              store: false,
            },
          },
          { signal: o.signal },
        );
        const recorder = opts.onRecording ? new StereoRecorder(24000, Date.now()) : undefined;
        let saved = false;
        const url = `${this.o.liveUrl ?? LIVE_URL}/${encodeURIComponent(sessionId)}/attach`;
        return attachSideband(
          url,
          this.o.apiKey,
          o,
          {
            ...h,
            onClose: () => {
              if (recorder && !saved) {
                saved = true;
                opts.onRecording!(recorder.toWav());
              }
              h.onClose();
            },
          },
          { recorder, greetAfter: opts.greetAfter },
        );
      },
    };
  }
}
