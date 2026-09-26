import { mkdir } from "node:fs/promises";
import OpenAI from "openai";
import type { ClientEvent, ServerEvent } from "openai/resources/live/live";
import { LIVE_URL } from "../src/adapters/openai-live/session";
import { b64decode, b64encode, BYTES_PER_MS, levelDbfs } from "../src/core/audio";
import { fillCurrentTime, ownerAppendText, type AppConfig, type LiveAppend } from "../src/core/config";
import { parseOwnerMessage } from "../src/core/owner-desk";
import { parseLines, type Line, type LiveCase, type Settings } from "./cases";
import type { Judge } from "./judge";
import type { Outcome } from "./run";

// One spoken caller turn to real gpt-live-1, the cookbook's single-turn approach ("CRAWL",
// https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation): the conversation
// so far goes in as startup text history, then TTS audio of the caller's turn streams in real
// time. Its own small client, not the app's adapter: what's under test is the prompt and config.

const FORMAT = "pcm24" as const; // TTS "pcm" is 24 kHz PCM16LE, Live's audio/pcm at 24000
const FRAME_MS = 20;
const LEAD_MS = 600; // silence before the caller speaks
const SETTLE_MS = 600; // after_caller texts go out this long after the caller stops (like Jev's settle_ms)

const APPEND_EVENT = {
  instructions: "session.instructions.append",
  thinking: "session.thinking.append",
  commentary: "session.commentary.append",
} as const satisfies Record<LiveAppend, ClientEvent["type"]>;

export async function runLiveCase(c: LiveCase, cfg: AppConfig, s: Settings, apiKey: string, judge: Judge): Promise<Outcome> {
  const callerAudio = await tts(c.caller, s, apiKey);
  const history = parseLines(c.history);
  const reply = await converse({
    cfg,
    apiKey,
    history,
    told: c.told.map((stage) => stageText(cfg, stage)),
    afterCaller: c.after_caller.map((stage) => stageText(cfg, stage)),
    callerAudio,
    quietMs: s.live_quiet_ms,
    timeoutMs: s.live_timeout_ms,
  });
  const notes = [reply.delegated && "asked for help (answered with the fallback)", reply.timedOut && "timed out"].filter(Boolean);
  const conversation = [...history.map((l) => `${l.speaker}: ${l.text}`), `caller: ${c.caller}`].join("\n");
  const g = await judge.grade({ conversation, produced: `The agent's reply:\n${reply.text}`, passIf: c.pass_if });
  return { pass: g.pass, detail: g.reason, log: `agent: ${reply.text || "(silent)"}${notes.length ? `\n    (${notes.join(", ")})` : ""}` };
}

/** A call-flow stage's tell_live text, as the flow would send it; `button:<label>` is a Telegram steering button's. */
function stageText(cfg: AppConfig, stage: string): { as: LiveAppend; text: string } {
  const st = cfg.telegram.steering;
  // The owner's typed Telegram message, as CallSession.steerFromOwner sends it.
  if (stage.startsWith("owner:")) {
    const s = parseOwnerMessage(st, stage.slice("owner:".length));
    return { as: s.as, text: ownerAppendText(st, s.text) };
  }
  if (stage.startsWith("button:")) {
    const label = stage.slice("button:".length);
    const b = st.buttons.find((x) => x.label === label);
    if (!b) throw new Error(`no telegram.yaml steering button "${label}"`);
    return { as: b.as, text: ownerAppendText(st, b.text) };
  }
  const t = cfg.flow.rules.find((r) => r.stage === stage)?.then?.tell_live;
  if (!t) throw new Error(`no call-flow rule "${stage}" with tell_live`);
  return { as: t.as, text: t.text };
}

async function tts(text: string, s: Settings, apiKey: string): Promise<Uint8Array> {
  const key = new Bun.CryptoHasher("sha256").update(`${s.tts_model}|${s.tts_voice}|${text}`).digest("hex").slice(0, 16);
  const path = `${import.meta.dir}/.cache/tts-${key}.pcm`;
  const cached = Bun.file(path);
  if (await cached.exists()) return new Uint8Array(await cached.arrayBuffer());
  const res = await new OpenAI({ apiKey }).audio.speech.create({ model: s.tts_model, voice: s.tts_voice, input: text, response_format: "pcm" });
  const pcm = new Uint8Array(await res.arrayBuffer());
  await mkdir(`${import.meta.dir}/.cache`, { recursive: true });
  await Bun.write(path, pcm);
  return pcm;
}

interface Conversation {
  cfg: AppConfig;
  apiKey: string;
  history: Line[];
  told: { as: LiveAppend; text: string }[];
  afterCaller: { as: LiveAppend; text: string }[];
  callerAudio: Uint8Array;
  quietMs: number;
  timeoutMs: number;
}

/** Streams the caller's turn and collects what the agent says until it goes quiet. */
function converse(o: Conversation): Promise<{ text: string; delegated: boolean; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LIVE_URL, { headers: { Authorization: `Bearer ${o.apiKey}` }, perMessageDeflate: false });
    const send = (ev: ClientEvent) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(ev));
    const agentDbfs = o.cfg.connection.speech_detection.agent_dbfs;
    const frameBytes = FRAME_MS * BYTES_PER_MS[FORMAT];
    const callerMs = o.callerAudio.length / BYTES_PER_MS[FORMAT];
    let reply = "";
    let start = 0;
    let sentMs = 0;
    let agentSpeechUntil = 0;
    let delegated = false;
    let afterSent = false;
    let pump: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => finish(true), o.timeoutMs);

    const finish = (timedOut: boolean) => {
      clearInterval(pump);
      clearTimeout(deadline);
      send({ type: "session.close" });
      setTimeout(() => ws.close(), 200);
      resolve({ text: reply.replace(/\s+/g, " ").trim(), delegated, timedOut });
    };

    // Live only advances while input audio arrives: silence, then the caller, then silence.
    const tick = () => {
      const elapsed = Date.now() - start;
      while (sentMs + FRAME_MS <= elapsed) {
        const at = (sentMs - LEAD_MS) * BYTES_PER_MS[FORMAT];
        const frame = new Uint8Array(frameBytes);
        if (at >= 0 && at < o.callerAudio.length) frame.set(o.callerAudio.subarray(at, at + frameBytes));
        send({ type: "session.input_audio.append", audio: b64encode(frame) });
        sentMs += FRAME_MS;
      }
      const callerDoneAt = LEAD_MS + callerMs;
      if (!afterSent && elapsed >= callerDoneAt + SETTLE_MS) {
        afterSent = true;
        for (const t of o.afterCaller) send({ type: APPEND_EVENT[t.as], delegation_id: null, content: t.text });
      }
      if (elapsed > callerDoneAt && reply.trim() && Date.now() > agentSpeechUntil + o.quietMs) finish(false);
    };

    ws.onopen = () =>
      send({
        type: "session.start",
        session: {
          model: o.cfg.live.model,
          instructions: fillCurrentTime(o.cfg.live.instructions, Date.now()),
          audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: o.cfg.live.voice } },
          delegation: { type: "client" },
          // "Developer and user messages use input_text; assistant messages use text or output_text."
          input: o.history.map((m) =>
            m.speaker === "agent"
              ? { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: m.text }] }
              : { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: m.text }] },
          ),
          store: false,
        },
      });

    ws.onmessage = (m) => {
      const ev = JSON.parse(String(m.data)) as ServerEvent;
      switch (ev.type) {
        case "session.started":
          for (const t of o.told) send({ type: APPEND_EVENT[t.as], delegation_id: null, content: t.text });
          start = Date.now();
          pump = setInterval(tick, 10);
          break;
        case "session.output_audio.delta": {
          const bytes = b64decode(ev.delta);
          if (levelDbfs(bytes, FORMAT) < agentDbfs) break; // padding between phrases
          agentSpeechUntil = Math.max(Date.now(), agentSpeechUntil) + bytes.length / BYTES_PER_MS[FORMAT];
          break;
        }
        case "session.output_transcript.delta":
          if (!start) break;
          reply += ev.delta;
          agentSpeechUntil = Math.max(agentSpeechUntil, Date.now());
          break;
        case "session.delegation.created": {
          // The app would ask Luna; the eval answers with the configured fallback.
          delegated = true;
          const f = o.cfg.flow.when_live_asks_for_help.fallback;
          send({ type: APPEND_EVENT[f.as], delegation_id: ev.delegation.id, content: f.text });
          break;
        }
        case "error":
          clearInterval(pump);
          clearTimeout(deadline);
          ws.close();
          reject(new Error(`Live: ${ev.error.code}: ${ev.error.message}`));
          break;
      }
    };
    ws.onerror = () => reject(new Error("Live WebSocket error"));
  });
}
