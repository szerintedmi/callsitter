// HMAC token for the media WebSocket path (/media/{callId}/{codec}/{token}). Stateless, so
// it keeps working in the Workers port. IDs go in the path, not the query.

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mediaToken(secret: string, callId: string, codec: string) {
  return b64url(await hmac(secret, `media:${callId}:${codec}`));
}

export async function verifyMediaToken(secret: string, callId: string, codec: string, token: string) {
  const expected = await mediaToken(secret, callId, codec);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
