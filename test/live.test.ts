import { describe, expect, test } from "bun:test";
import { OpenAiLiveAgent } from "../src/adapters/openai-live/session";
import type { Codec } from "../src/core/audio";
import type { VoiceSessionHandlers, VoiceSessionOptions } from "../src/core/ports";

const noop: VoiceSessionHandlers = {
  onAudio() {},
  onTranscriptDelta() {},
  onTranscriptDone() {},
  onInterrupt() {},
  onDelegation() {},
  onError() {},
  onClose() {},
};

/** Opens a Live session against a local fake server and returns the `session.start` it sent. */
async function sessionStart(codec: Codec) {
  let resolveMsg!: (v: any) => void;
  const first = new Promise<any>((r) => (resolveMsg = r));
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: { message: (_ws, m) => resolveMsg(JSON.parse(String(m))) },
  });
  const live: VoiceSessionOptions["config"] = { model: "gpt-live-1", instructions: "hi", greeting: "Hello?", voice: "marin" };
  new OpenAiLiveAgent({ apiKey: "k", url: `ws://127.0.0.1:${server.port}` }).connect({ config: live, codec }, noop).catch(() => {});
  const msg = await first;
  server.stop(true);
  return msg;
}

describe("Live session audio format", () => {
  test.each([
    ["pcmu", { type: "audio/pcmu", rate: 8000 }],
    ["pcma", { type: "audio/pcma", rate: 8000 }],
    ["l16", { type: "audio/pcm", rate: 16000 }],
  ] as const)("%s → %o", async (codec, format) => {
    const msg = await sessionStart(codec);
    expect(msg.type).toBe("session.start");
    expect(msg.session.audio.format).toEqual(format);
    expect(msg.session.audio.output).toEqual({ voice: "marin" });
  });
});

describe("Live session greeting", () => {
  /** Runs a session against a fake server that starts it, and returns every command the client sent. */
  async function commands(greeted?: string) {
    const got: any[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message(ws, m) {
          const msg = JSON.parse(String(m));
          got.push(msg);
          if (msg.type === "session.start") ws.send(JSON.stringify({ type: "session.started", session: {} }));
        },
      },
    });
    const live = { model: "gpt-live-1", instructions: "hi", deflection: "", voice: "marin", greeting: "Hello?" } as VoiceSessionOptions["config"];
    const s = await new OpenAiLiveAgent({ apiKey: "k", url: `ws://127.0.0.1:${server.port}` }).connect({ config: live, codec: "l16", greeted }, noop);
    await Bun.sleep(50);
    s.close();
    server.stop(true);
    return got;
  }

  test("asks Live to say the greeting first", async () => {
    const got = await commands();
    expect(got[0].session.input).toBeUndefined();
    expect(got.find((c) => c.type === "session.instructions.append")?.content).toContain('say "Hello?"');
  });

  test("after a recorded greeting, starts from it instead of asking again", async () => {
    const got = await commands("Hello?");
    expect(got[0].session.input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello?" }] },
    ]);
    expect(got.some((c) => c.type === "session.instructions.append")).toBe(false);
  });
});

describe("Live session appends and usage", () => {
  test("each append kind goes out as its own Live command; usage reports reach onUsage", async () => {
    const got: any[] = [];
    const usage: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message(ws, m) {
          const msg = JSON.parse(String(m));
          got.push(msg);
          if (msg.type !== "session.start") return;
          ws.send(JSON.stringify({ type: "session.started", session: {} }));
          ws.send(JSON.stringify({ type: "session.usage.updated", event_id: "e1", usage: { seconds: 60 }, context_window: { usage_ratio: 0.12 } }));
          ws.send(JSON.stringify({ type: "session.usage.updated", event_id: "e2", usage: { seconds: 120 } }));
        },
      },
    });
    const live: VoiceSessionOptions["config"] = { model: "gpt-live-1", instructions: "hi", greeting: "Hello?", voice: "marin" };
    const s = await new OpenAiLiveAgent({ apiKey: "k", url: `ws://127.0.0.1:${server.port}` }).connect(
      { config: live, codec: "l16", greeted: "Hello?" },
      { ...noop, onUsage: (u) => void usage.push(u) },
    );
    s.append("instructions", "do this");
    s.append("thinking", "know this");
    s.append("commentary", "say this");
    await Bun.sleep(50);
    s.close();
    server.stop(true);
    expect(got.slice(1, 4)).toEqual([
      { type: "session.instructions.append", delegation_id: null, content: "do this" },
      { type: "session.thinking.append", delegation_id: null, content: "know this" },
      { type: "session.commentary.append", delegation_id: null, content: "say this" },
    ]);
    expect(usage).toEqual([
      { seconds: 60, contextRatio: 0.12 },
      { seconds: 120, contextRatio: undefined },
    ]);
  });
});

describe("Live session connect", () => {
  test("an aborted connect rejects with the reason and drops the socket", async () => {
    let serverSawClose!: () => void;
    const closed = new Promise<void>((r) => (serverSawClose = r));
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      // never sends session.started
      websocket: { message() {}, close: () => serverSawClose() },
    });
    const live = { model: "gpt-live-1", instructions: "hi", voice: "marin", greeting: "Hello?" } as VoiceSessionOptions["config"];
    const ac = new AbortController();
    const connecting = new OpenAiLiveAgent({ apiKey: "k", url: `ws://127.0.0.1:${server.port}` }).connect(
      { config: live, codec: "l16", signal: ac.signal },
      noop,
    );
    await Bun.sleep(50);
    ac.abort(new Error("Live didn't connect within 50 ms"));
    await expect(connecting).rejects.toThrow("Live didn't connect within 50 ms");
    await closed;
    server.stop(true);
  });
});
