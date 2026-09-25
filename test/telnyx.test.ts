import { describe, expect, test } from "bun:test";
import { b64decode, b64encode } from "../src/core/audio";
import { TelnyxApi } from "../src/adapters/telnyx/api";
import { inboundToLive, parseInbound, TelnyxMediaChannel } from "../src/adapters/telnyx/media";
import { TelnyxVerifier } from "../src/adapters/telnyx/signature";
import { decodeClientState, divertedFrom, encodeClientState } from "../src/adapters/telnyx/webhook";
import { mediaToken, verifyMediaToken } from "../src/web/media-token";

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const sign = async (msg: string) =>
    b64encode(new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg))));
  return { pubB64: b64encode(pub), sign };
}

describe("Telnyx webhook signature", () => {
  test("accepts a valid signature over `timestamp|body`", async () => {
    const { pubB64, sign } = await keypair();
    const v = new TelnyxVerifier(pubB64);
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"data":{"event_type":"call.initiated"}}';
    expect(await v.verify(body, await sign(`${ts}|${body}`), ts)).toBe(true);
  });

  test("rejects tampered body, stale timestamp and missing headers", async () => {
    const { pubB64, sign } = await keypair();
    const v = new TelnyxVerifier(pubB64);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(`${ts}|{"a":1}`);
    expect(await v.verify('{"a":2}', sig, ts)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(await v.verify('{"a":1}', await sign(`${old}|{"a":1}`), old)).toBe(false);
    expect(await v.verify('{"a":1}', null, ts)).toBe(false);
    expect(await v.verify('{"a":1}', "not base64!", ts)).toBe(false);
  });

  test("rejects a malformed public key", () => {
    expect(() => new TelnyxVerifier(b64encode(new Uint8Array(10)))).toThrow(/32-byte/);
  });
});

describe("Telnyx media channel", () => {
  test("re-frames agent audio into ≥20 ms chunks and pads the tail", async () => {
    const sent: string[] = [];
    const ch = new TelnyxMediaChannel((m) => sent.push(m), () => {}, "pcmu");
    ch.sendAudio(b64encode(new Uint8Array(100).fill(1))); // 12.5 ms: held back
    expect(sent).toHaveLength(0);
    ch.sendAudio(b64encode(new Uint8Array(300).fill(2))); // 400 bytes → 320 sent, 80 held
    expect(sent).toHaveLength(1);
    expect(b64decode(JSON.parse(sent[0]!).media.payload).length).toBe(320);
    await Bun.sleep(100);
    expect(sent).toHaveLength(2);
    const tail = b64decode(JSON.parse(sent[1]!).media.payload);
    expect(tail.length).toBe(160);
    expect(tail[79]).toBe(2);
    expect(tail[80]).toBe(0xff); // μ-law silence
  });

  test("clear drops buffered audio and sends a clear event", async () => {
    const sent: string[] = [];
    const ch = new TelnyxMediaChannel((m) => sent.push(m), () => {}, "pcmu");
    ch.sendAudio(b64encode(new Uint8Array(100)));
    ch.clear();
    await Bun.sleep(100);
    expect(sent.map((m) => JSON.parse(m).event)).toEqual(["clear"]);
  });

  test("L16 byte order is swapped both ways", () => {
    const be = b64encode(new Uint8Array([0x12, 0x34]));
    expect(b64decode(inboundToLive(be, "l16"))).toEqual(new Uint8Array([0x34, 0x12]));
    expect(inboundToLive(be, "pcmu")).toBe(be);
    expect(inboundToLive(be, "pcma")).toBe(be);
  });

  test("PCMA passes agent audio through and pads the tail with A-law silence", async () => {
    const sent: string[] = [];
    const ch = new TelnyxMediaChannel((m) => sent.push(m), () => {}, "pcma");
    ch.sendAudio(b64encode(new Uint8Array(200).fill(0x12)));
    expect(b64decode(JSON.parse(sent[0]!).media.payload)).toEqual(new Uint8Array(160).fill(0x12));
    await Bun.sleep(100);
    const tail = b64decode(JSON.parse(sent[1]!).media.payload);
    expect(tail[39]).toBe(0x12);
    expect(tail[40]).toBe(0xd5);
  });

  test("parses inbound frames", () => {
    expect(parseInbound('{"event":"media","stream_id":"s","media":{"track":"inbound","payload":"AA=="}}')?.event).toBe("media");
    expect(parseInbound("nope")).toBeNull();
  });
});

describe("Telnyx answer", () => {
  async function answerBodies(codec: "pcmu" | "pcma" | "l16") {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const api = new TelnyxApi({
      apiKey: "k",
      smsFrom: "ScamSitter",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ data: {} });
      }) as unknown as typeof fetch,
    });
    await api.answer("cc1", "wss://h/media/x", codec);
    return calls;
  }

  test("G.711 codecs answer with a bidirectional RTP stream in the same codec", async () => {
    for (const [codec, name] of [["pcmu", "PCMU"], ["pcma", "PCMA"]] as const) {
      const [call, ...rest] = await answerBodies(codec);
      expect(rest).toHaveLength(0);
      expect(call!.url).toEndWith("/calls/cc1/actions/answer");
      expect(call!.body).toMatchObject({ stream_codec: name, stream_bidirectional_codec: name, stream_bidirectional_mode: "rtp" });
    }
  });

  test("L16 answers, then starts a 16 kHz stream", async () => {
    const [answer, start] = await answerBodies("l16");
    expect(answer!.body.stream_url).toBeUndefined();
    expect(start!.url).toEndWith("/calls/cc1/actions/streaming_start");
    expect(start!.body).toMatchObject({ stream_bidirectional_codec: "L16", stream_bidirectional_sampling_rate: 16000 });
  });
});

describe("Telnyx webhook helpers", () => {
  test("extracts the diverting number from a Diversion header", () => {
    expect(divertedFrom([{ name: "Diversion", value: "<sip:+447700900123@1.2.3.4>;reason=unconditional" }])).toBe(
      "+447700900123",
    );
    expect(divertedFrom([{ name: "User-to-User", value: "x" }])).toBeUndefined();
    expect(divertedFrom(undefined)).toBeUndefined();
  });

  test("client_state round trip", () => {
    expect(decodeClientState(encodeClientState({ callId: "abc" }))).toEqual({ callId: "abc" });
    expect(decodeClientState("%%%")).toBeNull();
  });
});

describe("media token", () => {
  test("binds call id and codec", async () => {
    const t = await mediaToken("s".repeat(32), "call-1", "pcmu");
    expect(await verifyMediaToken("s".repeat(32), "call-1", "pcmu", t)).toBe(true);
    expect(await verifyMediaToken("s".repeat(32), "call-2", "pcmu", t)).toBe(false);
    expect(await verifyMediaToken("s".repeat(32), "call-1", "l16", t)).toBe(false);
    expect(await verifyMediaToken("x".repeat(32), "call-1", "pcmu", t)).toBe(false);
  });
});
