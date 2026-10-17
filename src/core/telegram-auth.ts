// Telegram Mini App initData (the takeover page's proof of who opened it), checked as in
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
// secret_key = HMAC_SHA256(key "WebAppData", bot token); the hash is hex(HMAC_SHA256(key secret_key,
// data_check_string)), where data_check_string is every field but `hash`, sorted by key, `key=value`
// (URL-decoded) joined by "\n". Newer clients also send `signature` (Ed25519, for third parties
// without the token): it is one of the signed fields, so it stays in the data-check-string.
// WebCrypto only, so this runs on Workers too.

const enc = new TextEncoder();
/** auth_date this far ahead of our clock still counts (clock skew) */
const MAX_FUTURE_S = 60;

/** Validates Telegram Mini App initData (WebCrypto HMAC); null if invalid or older than maxAgeS. */
export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeS: number,
  nowMs: number = Date.now(),
): Promise<{ userId: number; authDate: number } | null> {
  const fields = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(initData)) {
    // A repeated key could be read differently here and by whoever signed it.
    if (fields.has(k)) return null;
    fields.set(k, v);
  }
  const hash = fields.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  fields.delete("hash");
  const check = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const hmacKey = (raw: ArrayBuffer | Uint8Array<ArrayBuffer>) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const secret = await crypto.subtle.sign("HMAC", await hmacKey(enc.encode("WebAppData")), enc.encode(botToken));
  // verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), hexBytes(hash), enc.encode(check));
  if (!ok) return null;

  const authDate = Number(fields.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return null;
  const ageS = nowMs / 1000 - authDate;
  if (ageS > maxAgeS || ageS < -MAX_FUTURE_S) return null;

  let userId: unknown;
  try {
    userId = (JSON.parse(fields.get("user") ?? "null") as { id?: unknown } | null)?.id;
  } catch {
    return null;
  }
  if (typeof userId !== "number" || !Number.isSafeInteger(userId)) return null;
  return { userId, authDate };
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
