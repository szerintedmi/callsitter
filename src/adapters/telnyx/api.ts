import type { Codec } from "../../core/audio";
import type { Notifier, Telephony } from "../../core/ports";

// Telnyx Call Control v2 REST (https://developers.telnyx.com/api-reference/call-commands).

const BASE = "https://api.telnyx.com/v2";

export class TelnyxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }

  /** One line for logs and the UI, e.g. `answer: 422 Call has already ended (90018)`. */
  get summary(): string {
    let detail = this.body.slice(0, 200);
    try {
      const e = (JSON.parse(this.body) as { errors?: { code?: string; title?: string }[] }).errors?.[0];
      if (e?.title) detail = e.code ? `${e.title} (${e.code})` : e.title;
    } catch {}
    return `${this.message.split(" failed:")[0]}: ${this.status} ${detail}`.trim();
  }
}

export interface TelnyxApiOptions {
  apiKey: string;
  /** SMS sender: a +447 number or an alphanumeric sender ID; sms() throws when unset */
  smsFrom?: string;
  messagingProfileId?: string;
  fetch?: typeof fetch;
}

export class TelnyxApi implements Telephony, Notifier {
  private f: typeof fetch;

  constructor(private o: TelnyxApiOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>) {
    const res = await this.f(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const action = path.split("/").pop() ?? path;
      throw new TelnyxApiError(`Telnyx ${action} failed: ${res.status} ${text.slice(0, 300)}`, res.status, text);
    }
    return res.json().catch(() => ({}));
  }

  private action(ccid: string, action: string, body: Record<string, unknown> = {}) {
    return this.post(`/calls/${encodeURIComponent(ccid)}/actions/${action}`, body);
  }

  /**
   * Answers with a bidirectional RTP media stream. `answer` has no sampling-rate option, so
   * L16/16k is started separately with streaming_start after answering.
   */
  async answer(ccid: string, streamUrl: string, codec: Codec, clientState?: string) {
    const commandId = crypto.randomUUID();
    const cs = clientState ? { client_state: clientState } : {};
    if (codec !== "l16") {
      const g711 = codec === "pcmu" ? "PCMU" : "PCMA";
      await this.action(ccid, "answer", {
        ...cs,
        command_id: commandId,
        stream_url: streamUrl,
        stream_track: "inbound_track",
        stream_codec: g711,
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: g711,
      });
      return;
    }
    await this.action(ccid, "answer", { ...cs, command_id: commandId });
    await this.action(ccid, "streaming_start", {
      stream_url: streamUrl,
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    });
  }

  /**
   * Noise suppression on the call leg (BETA). Telnyx `outbound` = audio received from the
   * caller, i.e. what Live hears. The docs recommend it for streaming/AI but don't say whether
   * it applies before the media fork; verify on a real call.
   * https://developers.telnyx.com/docs/voice/programmable-voice/noise-suppression
   */
  suppressionStart(ccid: string, o: { engine: string; direction: "outbound" | "inbound" | "both" }) {
    return this.action(ccid, "suppression_start", {
      direction: o.direction,
      noise_suppression_engine: o.engine,
      command_id: crypto.randomUUID(),
    });
  }

  /**
   * Transfers a call (e.g. a parked WebRTC leg) to a SIP URI over TLS with SRTP media, which
   * OpenAI's SIP endpoint requires. https://developers.telnyx.com/api-reference/call-commands/transfer-call
   */
  transferToSip(ccid: string, o: { to: string; customHeaders?: { name: string; value: string }[]; clientState?: string }) {
    return this.action(ccid, "transfer", {
      to: o.to,
      sip_transport_protocol: "TLS",
      media_encryption: "SRTP",
      command_id: crypto.randomUUID(),
      ...(o.customHeaders?.length ? { custom_headers: o.customHeaders } : {}),
      ...(o.clientState ? { client_state: o.clientState } : {}),
    });
  }

  recordStart(ccid: string, clientState?: string) {
    return this.action(ccid, "record_start", {
      format: "mp3",
      channels: "dual",
      command_id: crypto.randomUUID(),
      ...(clientState ? { client_state: clientState } : {}),
    });
  }

  async hangup(ccid: string) {
    try {
      await this.action(ccid, "hangup", { command_id: crypto.randomUUID() });
    } catch (err) {
      // 422 when the call is already gone; nothing to do.
      if (err instanceof TelnyxApiError && err.status === 422) return;
      throw err;
    }
  }

  async sms(to: string, text: string) {
    if (!this.o.smsFrom) throw new Error("SMS not configured (TELNYX_SMS_FROM)");
    await this.post("/messages", {
      from: this.o.smsFrom,
      to,
      text,
      ...(this.o.messagingProfileId ? { messaging_profile_id: this.o.messagingProfileId } : {}),
    });
  }

  /**
   * A WebRTC login token (JWT) for a telephony credential, for the browser SIP test. The
   * endpoint returns the token as plain text.
   * https://developers.telnyx.com/api-reference/telephony-credentials/create-an-access-token
   */
  async webrtcToken(credentialId: string): Promise<string> {
    const res = await this.f(`${BASE}/telephony_credentials/${encodeURIComponent(credentialId)}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}` },
    });
    const text = await res.text();
    if (!res.ok) throw new TelnyxApiError(`Telnyx token failed: ${res.status} ${text.slice(0, 300)}`, res.status, text);
    return text.trim();
  }

  /** Recording URLs from call.recording.saved are pre-signed and valid for 10 minutes. */
  async download(url: string): Promise<ArrayBuffer> {
    const res = await this.f(url);
    if (!res.ok) throw new TelnyxApiError(`recording download failed: ${res.status}`, res.status, "");
    return res.arrayBuffer();
  }
}
