// One-off, idempotent setup for OpenAI SIP and the browser SIP test (README → OpenAI SIP):
//   1. OpenAI: a project webhook for live.transport.incoming → https://<hooks host>/openai/webhook
//   2. Telnyx: a credential connection plus a telephony credential the browser test logs in with.
//      The connection parks the browser's calls and sends webhooks to /telnyx/webhook, which
//      transfers them to OpenAI (a WebRTC client can't dial an external SIP URI itself).
// It writes OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET, TELNYX_SIP_CONNECTION_ID and
// TELNYX_SIP_CREDENTIAL_ID into .env
// (secrets are never printed). Re-running reuses what exists; --rotate-secret issues a new
// webhook secret (needed if the endpoint exists but .env lost its secret).
//
//   bun scripts/setup-sip.ts [--dry-run] [--rotate-secret]
import OpenAI from "openai";
import { readEnv } from "../src/runtime/env";

const DRY = process.argv.includes("--dry-run");
const ROTATE = process.argv.includes("--rotate-secret");
const WEBHOOK_NAME = "scamsitter-sip";
const CONNECTION_NAME = "scamsitter-sip-test";
const CREDENTIAL_NAME = "scamsitter-browser";
const TELNYX = "https://api.telnyx.com/v2";

const env = readEnv();
const log = (s: string) => console.log(`${DRY ? "[dry-run] " : ""}${s}`);

/** Writes one .env value straight away, so a later failure can't lose a secret. */
async function setEnv(k: string, v: string) {
  if ((process.env[k] ?? "") === v) return;
  log(`.env: set ${k}`);
  if (DRY) return;
  const file = Bun.file(".env");
  let text = (await file.exists()) ? await file.text() : "";
  const re = new RegExp(`^${k}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\n?$/, "\n")}${k}=${v}\n`;
  await Bun.write(".env", text);
  process.env[k] = v;
}

// --- OpenAI -------------------------------------------------------------------------------
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
// The project is the API key's; responses name it in the openai-project header.
const probe = await openai.webhooks.list({ limit: 100 }).withResponse();
const projectId = probe.response.headers.get("openai-project");
if (!projectId?.startsWith("proj_")) throw new Error("could not tell the OpenAI project from the API key (no openai-project header)");
if (env.OPENAI_PROJECT_ID && env.OPENAI_PROJECT_ID !== projectId) {
  throw new Error(`OPENAI_PROJECT_ID is ${env.OPENAI_PROJECT_ID} but the API key belongs to ${projectId}`);
}
await setEnv("OPENAI_PROJECT_ID", projectId);
log(`OpenAI project ${projectId}`);

const webhookUrl = `${env.PUBLIC_WS_BASE.replace(/^ws/, "http")}/openai/webhook`;
const existing: OpenAI.Webhooks.WebhookEndpoint[] = [];
for await (const w of openai.webhooks.list({ limit: 100 })) existing.push(w);
const mine = existing.find((w) => w.url === webhookUrl);
if (!mine) {
  log(`creating webhook ${WEBHOOK_NAME}: live.transport.incoming → ${webhookUrl}`);
  if (!DRY) {
    // The SDK's event_types union predates live.transport.incoming.
    const created = await openai.webhooks.create({
      name: WEBHOOK_NAME,
      url: webhookUrl,
      event_types: ["live.transport.incoming"] as unknown as OpenAI.Webhooks.WebhookCreateParams["event_types"],
    });
    await setEnv("OPENAI_WEBHOOK_SECRET", created.signing_secret);
  }
} else {
  log(`webhook ${mine.id} exists (${mine.event_types.join(", ")})`);
  if (!mine.event_types.includes("live.transport.incoming")) {
    log(`adding live.transport.incoming to ${mine.id}`);
    if (!DRY) {
      await openai.webhooks.update(mine.id, {
        event_types: [...mine.event_types, "live.transport.incoming"] as unknown as OpenAI.Webhooks.WebhookUpdateParams["event_types"],
      });
    }
  }
  if (ROTATE || !env.OPENAI_WEBHOOK_SECRET) {
    if (!ROTATE) throw new Error(`webhook ${mine.id} exists but OPENAI_WEBHOOK_SECRET is not set: re-run with --rotate-secret`);
    log(`rotating the signing secret of ${mine.id}`);
    if (!DRY) await setEnv("OPENAI_WEBHOOK_SECRET", (await openai.webhooks.rotateSecret(mine.id)).signing_secret);
  }
}

// --- Telnyx -------------------------------------------------------------------------------
async function telnyx(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${TELNYX}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Telnyx ${method} ${path}: ${res.status} ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`);
  return json;
}

const conns = (await telnyx("GET", `/credential_connections?filter[connection_name][contains]=${CONNECTION_NAME}`)).data as any[];
let conn = conns.find((c) => c.connection_name === CONNECTION_NAME);
if (!conn) {
  // Outbound calls need an outbound voice profile; reuse the account's if there is exactly one.
  const ovps = (await telnyx("GET", "/outbound_voice_profiles")).data as any[];
  const ovp = ovps.length === 1 ? ovps[0].id : undefined;
  log(`creating Telnyx credential connection ${CONNECTION_NAME}${ovp ? ` (outbound voice profile ${ovps[0].name})` : " (no outbound voice profile)"}`);
  if (!DRY) {
    const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    conn = (
      await telnyx("POST", "/credential_connections", {
        connection_name: CONNECTION_NAME,
        user_name: `scamsitter${rand(10)}`,
        password: rand(32),
        active: true,
        ...(ovp ? { outbound: { outbound_voice_profile_id: ovp } } : {}),
      })
    ).data;
  }
} else log(`Telnyx credential connection ${conn.id} exists`);

// Park the browser's outbound calls and send their webhooks to us (Telnyx WebRTC "Pattern 1").
const telnyxWebhook = `${env.PUBLIC_WS_BASE.replace(/^ws/, "http")}/telnyx/webhook`;
if (conn && (conn.webhook_event_url !== telnyxWebhook || conn.outbound?.call_parking_enabled !== true)) {
  log(`connection ${conn.id}: park outbound calls, webhooks → ${telnyxWebhook}`);
  if (!DRY) {
    conn = (
      await telnyx("PATCH", `/credential_connections/${conn.id}`, {
        webhook_event_url: telnyxWebhook,
        webhook_api_version: "2",
        outbound: { ...conn.outbound, call_parking_enabled: true },
      })
    ).data;
  }
}
if (conn) await setEnv("TELNYX_SIP_CONNECTION_ID", conn.id);

if (env.TELNYX_SIP_CREDENTIAL_ID) {
  log(`telephony credential ${env.TELNYX_SIP_CREDENTIAL_ID} already in .env`);
} else if (conn) {
  const creds = (await telnyx("GET", `/telephony_credentials?filter[name]=${CREDENTIAL_NAME}`)).data as any[];
  let cred = creds.find((c) => c.connection_id === conn.id && !c.expired);
  if (!cred) {
    log(`creating telephony credential ${CREDENTIAL_NAME}`);
    if (!DRY) cred = (await telnyx("POST", "/telephony_credentials", { connection_id: conn.id, name: CREDENTIAL_NAME })).data;
  } else log(`telephony credential ${cred.id} exists`);
  if (cred) await setEnv("TELNYX_SIP_CREDENTIAL_ID", cred.id);
}

console.log(`
Next:
  - Tunnel: add openai/webhook to the public path regex in deploy/cloudflared.yml, e.g.
      path: ^/(telnyx/webhook|openai/webhook|media/.*|healthz)$
    and restart the tunnel.
  - Restart the app, open /test-call and pick "SIP".`);
