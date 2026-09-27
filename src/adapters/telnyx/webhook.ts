// Telnyx Call Control webhook envelope, reduced to the fields we use
// (telnyx npm package: resources/webhooks.d.ts).

export interface SipHeader {
  name: string;
  value: string;
}

export interface TelnyxWebhook {
  data: {
    event_type: string;
    id: string;
    occurred_at?: string;
    payload: {
      call_control_id?: string;
      connection_id?: string;
      state?: string;
      call_leg_id?: string;
      call_session_id?: string;
      client_state?: string | null;
      from?: string;
      to?: string;
      direction?: string;
      sip_headers?: SipHeader[];
      custom_headers?: SipHeader[];
      hangup_cause?: string;
      hangup_source?: string;
      /** call.cost: whether Telnyx could price the call; on "error" total_cost is null */
      status?: string;
      /** call.cost: the call's total, a decimal string ("0.0225") */
      total_cost?: string | null;
      /** call.cost: the total by product (trunking, call control, recording), each with its currency */
      cost_parts?: { currency?: string }[];
      recording_urls?: { mp3?: string; wav?: string };
      public_recording_urls?: { mp3?: string; wav?: string };
      recording_id?: string;
    };
  };
}

/**
 * Best-effort diverting number from the SIP Diversion header
 * (e.g. `<sip:+447700900123@example.com>;reason=unconditional`). UK networks often strip it.
 */
export function divertedFrom(headers: SipHeader[] | undefined): string | undefined {
  const h = headers?.find((x) => x.name.toLowerCase() === "diversion");
  if (!h) return undefined;
  const m = h.value.match(/(?:sips?|tel):(\+?[0-9]+)/i);
  return m?.[1];
}

/**
 * A webhook payload's fields as display strings, by field name ("call_quality_stats.inbound.mos"
 * for nested ones), leaving out `skip`, empty values and lists. Everything else the carrier sends
 * is kept, so fields that appear only on some calls (e.g. STIR/SHAKEN) aren't missed.
 */
export function payloadInfo(payload: object, skip: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (obj: object, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix + k;
      if (skip.includes(key) || v === null || v === undefined || v === "" || Array.isArray(v)) continue;
      if (typeof v === "object") walk(v, key + ".");
      else out[key] = String(v);
    }
  };
  walk(payload, "");
  return out;
}

export function encodeClientState(obj: Record<string, string>): string {
  return btoa(JSON.stringify(obj));
}

export function decodeClientState(s: string | null | undefined): Record<string, string> | null {
  if (!s) return null;
  try {
    return JSON.parse(atob(s));
  } catch {
    return null;
  }
}
