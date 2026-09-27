import { upgradeWebSocket, websocket } from "hono/bun";
import { join } from "node:path";
import { watchConfig, YamlDirSource } from "../adapters/config/yaml-fs";
import { JevClassifier } from "../adapters/jev/classifier";
import { JevReferee } from "../adapters/jev/referee";
import { LunaAgent } from "../adapters/luna/agent";
import { OpenAiLiveAgent } from "../adapters/openai-live/session";
import { OpenAiSip } from "../adapters/openai-live/sip";
import { OpenAiWebRtc } from "../adapters/openai-live/webrtc";
import { FsBlobStore } from "../adapters/storage/fs-blob";
import { openSqlite, SqliteRepo } from "../adapters/storage/sqlite";
import { TelegramBot } from "../adapters/telegram/bot";
import { TelnyxApi } from "../adapters/telnyx/api";
import { TelnyxVerifier } from "../adapters/telnyx/signature";
import { CallManager } from "../core/call-manager";
import { GreetingCache } from "../core/greeting";
import { ConfigStore, loadConfig } from "../core/config";
import { MemoryEventBus } from "../core/event-bus";
import { OwnerDesk } from "../core/owner-desk";
import { attachPersistence } from "../core/persist";
import { createApp } from "../web/app";
import { controlRoutes } from "../web/control";
import { LogBuffer, mirrorConsole } from "../web/debug-log";
import { BrowserSipCalls } from "../web/openai-sip";
import { PublicGate } from "../web/public";
import { BrowserCalls, routeTelephony, type BrowserSipDeps } from "../web/test-call";
import { clientAssets } from "./client-assets";
import { readEnv, adminAuthFrom, publicHostOf } from "./env";

// Mirror console output into a buffer the test-call page's debug log shows.
const debugLog = new LogBuffer();
mirrorConsole(debugLog);

const env = readEnv();
const configVars = { ownerName: env.OWNER_NAME, agentLanguages: env.AGENT_LANGUAGES };
const config = new ConfigStore(await loadConfig(new YamlDirSource(env.CONFIG_DIR), configVars));
if (env.CONFIG_WATCH) watchConfig(env.CONFIG_DIR, config, configVars);

// Telegram to the owner (env.ts checks both are set, or neither); otherwise there are no status
// messages or steering, and Luna isn't offered the tool.
const telegram =
  env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? new TelegramBot({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID })
    : undefined;
if (!telegram) console.warn("[startup] Telegram to owner disabled (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID not set)");
else if (!telegram.canListen) console.warn("[startup] Telegram steering off: TELEGRAM_CHAT_ID is a channel, which can't message the bot");
const callLink = env.ADMIN_HOST ? (id: string) => `https://${env.ADMIN_HOST}/calls/${encodeURIComponent(id)}` : undefined;

const repo = new SqliteRepo(openSqlite(join(env.DATA_DIR, "scamsitter.db")));
const blobs = new FsBlobStore(env.DATA_DIR);
const bus = new MemoryEventBus();
const persistence = attachPersistence(bus, repo);
// Status messages and steering (telegram.yaml). `manager` is only read once a message arrives.
const desk = telegram
  ? new OwnerDesk({
      bus,
      chat: telegram,
      config: () => config.get(),
      clock: { now: () => Date.now() },
      callLink,
      canSteer: telegram.canListen,
      steer: (callId, text, as) => manager.get(callId)?.steerFromOwner(text, as) ?? { ok: false, reason: "the call isn't connected yet" },
      hangUp: (callId) => manager.get(callId)?.hangUpFromOwner() ?? { ok: false, reason: "the call isn't connected yet" },
    })
  : undefined;

const telnyx = new TelnyxApi({ apiKey: env.TELNYX_API_KEY });

const browserCalls = new BrowserCalls();

const voice = new OpenAiLiveAgent({ apiKey: env.OPENAI_API_KEY });
// Record the greeting in the agent's voice now (and again when the voice or greeting changes),
// so calls can say hello the moment they connect. Calls before it's ready ask Live to greet.
const greetings = new GreetingCache({ voice, blobs, config: () => config.get() });
void greetings.refresh();
config.onChange(() => void greetings.refresh());

// OpenAI SIP (README → OpenAI SIP): on when the project id and webhook secret are set.
const sip =
  env.OPENAI_PROJECT_ID && env.OPENAI_WEBHOOK_SECRET
    ? new OpenAiSip({ apiKey: env.OPENAI_API_KEY, webhookSecret: env.OPENAI_WEBHOOK_SECRET })
    : undefined;
const browserSip: BrowserSipDeps | undefined =
  sip && env.OPENAI_PROJECT_ID && env.TELNYX_SIP_CREDENTIAL_ID && env.TELNYX_SIP_CONNECTION_ID
    ? {
        calls: new BrowserSipCalls(),
        connectionId: env.TELNYX_SIP_CONNECTION_ID,
        projectId: env.OPENAI_PROJECT_ID,
        region: () => config.get().connection.sip.region,
        loginToken: () => telnyx.webrtcToken(env.TELNYX_SIP_CREDENTIAL_ID!),
      }
    : undefined;
console.log(`[startup] OpenAI SIP ${sip ? "on (/openai/webhook)" : "off"}; browser SIP test ${browserSip ? "on" : "off"}`);

const manager = new CallManager({
  config: () => config.get(),
  voice,
  greetings,
  classifier: new JevClassifier({ apiKey: env.TYPESAFE_API_KEY }),
  agent: new LunaAgent({ apiKey: env.OPENAI_API_KEY, config: () => config.get().luna }),
  bus,
  ownerStatus: desk ? () => desk.showsStatus : undefined,
  telephony: routeTelephony(telnyx, browserCalls, sip),
  clock: { now: () => Date.now() },
  repo,
  blobs,
});

const app = createApp({
  browserCalls,
  verifier: new TelnyxVerifier(env.TELNYX_PUBLIC_KEY),
  telnyx,
  manager,
  repo,
  blobs,
  bus,
  config,
  publicWsBase: env.PUBLIC_WS_BASE,
  adminAuth: adminAuthFrom(env),
  mediaSecret: env.MEDIA_TOKEN_SECRET,
  upgradeWebSocket,
  openAiSip: sip ? { sip } : undefined,
  debugLog,
  browserSip,
  publicPage: {
    host: publicHostOf(env),
    config: () => config.get(),
    gate: new PublicGate({ repo, config: () => config.get(), clock: { now: () => Date.now() } }),
    webrtc: new OpenAiWebRtc({ apiKey: env.OPENAI_API_KEY }),
    referee: new JevReferee({ apiKey: env.TYPESAFE_API_KEY }),
  },
  clientAssets: await clientAssets({ rebuild: process.env.NODE_ENV !== "production" }),
});

// Close calls left open by a previous run, then keep sweeping for calls whose media never connected.
await manager.reapOrphans(0, "server restarted");
setInterval(() => void manager.reapOrphans(60_000, "no media connected within 60 s").catch(console.error), 30_000);

const listening = new AbortController();
if (telegram?.canListen && desk) void telegram.listen({ message: (m) => desk.onMessage(m), button: (b) => desk.onButton(b) }, listening.signal);

const server = Bun.serve({ port: env.PORT, hostname: env.BIND_HOST, fetch: app.fetch, websocket });
// Always loopback, whatever BIND_HOST is: in the container only `docker compose exec` reaches it.
const control = Bun.serve({ port: env.CONTROL_PORT, hostname: "127.0.0.1", fetch: controlRoutes(manager).fetch });
const adminAt = env.ADMIN_AUTH === "access" ? `https://${env.ADMIN_HOST}/ (Cloudflare Access)` : `http://${server.hostname}:${server.port}/`;
console.log(`[startup] listening on http://${server.hostname}:${server.port}; admin UI at ${adminAt}`);

let shuttingDown = false;
const shutdown = async (sig: string) => {
  if (shuttingDown) {
    console.log(`[shutdown] ${sig} again: exiting without waiting for calls to wrap up`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[shutdown] ${sig}: hanging up calls and waiting for their wrap-up (${sig} again to force)`);
  // Hangs up live calls and waits for Luna, summaries and recordings, then for them to be stored.
  await manager.stopAll("server shutting down");
  listening.abort();
  await desk?.flush();
  await persistence.flush();
  server.stop();
  control.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
