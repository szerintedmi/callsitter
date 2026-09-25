import { b64decode } from "../../core/audio";

// Telnyx webhook signatures: Ed25519 over `${telnyx-timestamp}|${rawBody}`; reject if the
// timestamp is more than 5 minutes off
// (https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks).

export const TOLERANCE_SEC = 300;

export class TelnyxVerifier {
  private key: Promise<CryptoKey>;

  constructor(publicKeyB64: string) {
    const raw = b64decode(publicKeyB64);
    if (raw.length !== 32) throw new Error("TELNYX_PUBLIC_KEY must be a base64 32-byte Ed25519 key");
    this.key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  }

  async verify(rawBody: string, signatureB64: string | null, timestamp: string | null, nowSec = Date.now() / 1000) {
    if (!signatureB64 || !timestamp) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) return false;
    let sig: Uint8Array<ArrayBuffer>;
    try {
      sig = b64decode(signatureB64);
    } catch {
      return false;
    }
    if (sig.length !== 64) return false;
    return crypto.subtle.verify("Ed25519", await this.key, sig, new TextEncoder().encode(`${timestamp}|${rawBody}`));
  }
}
