// Moves the phone number to direct OpenAI SIP and back (README → OpenAI SIP, "For real calls").
//   on:  a Telnyx FQDN connection to OpenAI's SIP host on 5061 (TLS, SRTP, G.711), the number on it
//        with the project ID as its translated number and Telnyx's own dual-channel recording
//        (to check the sideband's audio against), and the OpenAI webhook pointed at this .env's
//        host (so a dev server can take the calls). What it replaces is saved for `off`.
//   off: puts back what `on` saved (number connection, voice settings, webhook URL).
//   status: prints the current setup.
// On the number, the Telnyx media stream path (Call Control) gets no calls; the browser test
// calls and the public page's WebRTC games don't use the number, so they keep working.
//
// --region eu uses sip-eu.api.openai.com ("for European data residency", voice-sip guide); `on`
// with another region swaps the connection's host.
//
//   bun scripts/direct-sip.ts status | on | off [--region global|eu] [--number +44…] [--dry-run]
import OpenAI from "openai";
import { SIP_HOSTS } from "../src/adapters/openai-live/sip";
import { readEnv } from "../src/runtime/env";

const [cmd] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DRY = process.argv.includes("--dry-run");
const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const numberArg = flag("--number");
const region = (flag("--region") ?? "global") as keyof typeof SIP_HOSTS;
const CONNECTION_NAME = "callsitter-openai-sip";
const OPENAI_SIP = { fqdn: SIP_HOSTS[region], port: 5061 };
const TELNYX = "https://api.telnyx.com/v2";
if (!["status", "on", "off"].includes(cmd ?? "") || !(region in SIP_HOSTS)) {
  console.error("usage: bun scripts/direct-sip.ts status | on | off [--region global|eu] [--number +44…] [--dry-run]");
  process.exit(1);
}

const env = readEnv();
const log = (s: string) => console.log(`${DRY ? "[dry-run] " : ""}${s}`);
const saved = Bun.file(`${env.DATA_DIR}/direct-sip-restore.json`);

interface Restore {
  numberId: string;
  phoneNumber: string;
  connectionId: string;
  translatedNumber: string | null;
  callRecording: unknown;
  webhookId: string;
  webhookUrl: string;
}

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

/** The number to move: --number, or the account's only active one. */
async function findNumber(): Promise<any> {
  const all = (await telnyx("GET", "/phone_numbers?page[size]=250")).data as any[];
  const wanted = numberArg?.replaceAll(" ", "");
  const matches = wanted ? all.filter((n) => n.phone_number === wanted) : all.filter((n) => n.status === "active");
  if (matches.length !== 1) throw new Error(wanted ? `${wanted} is not on this Telnyx account` : `${matches.length} active numbers: pick one with --number`);
  return matches[0];
}

/** The OpenAI webhook that receives live.transport.incoming (setup-sip.ts creates it). */
async function findWebhook(openai: OpenAI): Promise<OpenAI.Webhooks.WebhookEndpoint> {
  const hooks: OpenAI.Webhooks.WebhookEndpoint[] = [];
  for await (const w of openai.webhooks.list({ limit: 100 })) {
    if ((w.event_types as string[]).includes("live.transport.incoming")) hooks.push(w);
  }
  if (hooks.length !== 1) throw new Error(`${hooks.length} OpenAI webhooks take live.transport.incoming: expected 1 (run setup-sip.ts)`);
  return hooks[0]!;
}

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const number = await findNumber();
const voice = (await telnyx("GET", `/phone_numbers/${number.id}/voice`)).data;
const webhook = await findWebhook(openai);
const conn = ((await telnyx("GET", `/fqdn_connections?filter[connection_name][contains]=${CONNECTION_NAME}`)).data as any[]).find(
  (c) => c.connection_name === CONNECTION_NAME,
);

if (cmd === "status") {
  console.log(`number ${number.phone_number}: connection ${number.connection_id} (${number.connection_name ?? "?"})`);
  console.log(`  translated number: ${voice.translated_number || "none"}; recording: ${JSON.stringify(voice.call_recording)}`);
  console.log(`FQDN connection ${CONNECTION_NAME}: ${conn ? conn.id : "none"}${conn && conn.id === number.connection_id ? " (the number is on it: direct SIP)" : ""}`);
  if (conn) {
    const hosts = ((await telnyx("GET", `/fqdns?filter[connection_id]=${conn.id}`)).data as any[]).map((f) => `${f.fqdn}:${f.port}`);
    console.log(`  SIP host: ${hosts.join(", ") || "none"}`);
  }
  console.log(`OpenAI webhook ${webhook.id}: ${webhook.url}`);
  console.log(`restore file: ${(await saved.exists()) ? saved.name : "none"}`);
  process.exit(0);
}

if (cmd === "off") {
  if (!(await saved.exists())) throw new Error(`nothing to restore: ${saved.name} is missing`);
  const r = (await saved.json()) as Restore;
  log(`number ${r.phoneNumber}: connection → ${r.connectionId}`);
  log(`  translated number → ${r.translatedNumber || "none"}; recording → ${JSON.stringify(r.callRecording)}`);
  log(`OpenAI webhook ${r.webhookId}: url → ${r.webhookUrl}`);
  if (!DRY) {
    await telnyx("PATCH", `/phone_numbers/${r.numberId}`, { connection_id: r.connectionId });
    await telnyx("PATCH", `/phone_numbers/${r.numberId}/voice`, { translated_number: r.translatedNumber ?? "", call_recording: r.callRecording });
    await openai.webhooks.update(r.webhookId, { url: r.webhookUrl });
    await saved.delete();
  }
  log(`The FQDN connection ${CONNECTION_NAME} is left in place (unused).`);
  process.exit(0);
}

// --- on --------------------------------------------------------------------------------------
if (!env.OPENAI_PROJECT_ID) throw new Error("OPENAI_PROJECT_ID is not set: run setup-sip.ts first");
const webhookUrl = `${env.PUBLIC_WS_BASE.replace(/^ws/, "http")}/openai/webhook`;

let connId: string | undefined = conn?.id;
if (!conn) {
  log(`creating FQDN connection ${CONNECTION_NAME}: TLS, SRTP, G711A/G711U`);
  if (!DRY) {
    connId = (
      await telnyx("POST", "/fqdn_connections", {
        connection_name: CONNECTION_NAME,
        active: true,
        transport_protocol: "TLS",
        encrypted_media: "SRTP",
        // Measured 2026-09-27 (UK caller): London took ~130 ms per turn off Telnyx ↔ OpenAI
        // compared with the default (Latency); Ashburn was no better and adds the Atlantic.
        anchorsite_override: "London, UK",
        // UK PSTN is A-law: G.711 end to end avoids transcoding.
        inbound: { codecs: ["G711A", "G711U"] },
      })
    ).data.id;
  }
} else log(`FQDN connection ${conn.id} exists`);

const fqdns = connId ? ((await telnyx("GET", `/fqdns?filter[connection_id]=${connId}`)).data as any[]) : [];
if (!fqdns.some((f) => f.fqdn === OPENAI_SIP.fqdn && f.port === OPENAI_SIP.port)) {
  log(`adding ${OPENAI_SIP.fqdn}:${OPENAI_SIP.port} (A record) to the connection`);
  if (!DRY) await telnyx("POST", "/fqdns", { connection_id: connId, fqdn: OPENAI_SIP.fqdn, port: OPENAI_SIP.port, dns_record_type: "a" });
}
// Another region's host (added first, so the connection always has one).
for (const f of fqdns.filter((f) => f.fqdn !== OPENAI_SIP.fqdn || f.port !== OPENAI_SIP.port)) {
  log(`removing ${f.fqdn}:${f.port} from the connection`);
  if (!DRY) await telnyx("DELETE", `/fqdns/${f.id}`);
}

if (number.connection_id === connId && connId) log(`number ${number.phone_number} is already on ${connId}`);
else {
  if (await saved.exists()) throw new Error(`${saved.name} exists from an earlier \`on\`: run \`off\` first, or delete it`);
  const restore: Restore = {
    numberId: number.id,
    phoneNumber: number.phone_number,
    connectionId: number.connection_id,
    translatedNumber: voice.translated_number ?? null,
    callRecording: voice.call_recording,
    webhookId: webhook.id,
    webhookUrl: webhook.url,
  };
  log(`saving what this replaces to ${saved.name}`);
  if (!DRY) await Bun.write(saved, JSON.stringify(restore, null, 2));
  log(`number ${number.phone_number}: connection ${number.connection_id} → ${connId ?? "(new connection)"}`);
  if (!DRY) await telnyx("PATCH", `/phone_numbers/${number.id}`, { connection_id: connId });
}

log(`  translated number → ${env.OPENAI_PROJECT_ID}; Telnyx recording → dual-channel WAV`);
if (!DRY) {
  await telnyx("PATCH", `/phone_numbers/${number.id}/voice`, {
    translated_number: env.OPENAI_PROJECT_ID,
    call_recording: { inbound_call_recording_enabled: true, inbound_call_recording_format: "wav", inbound_call_recording_channels: "dual" },
  });
}

if (webhook.url === webhookUrl) log(`OpenAI webhook ${webhook.id} already → ${webhookUrl}`);
else {
  log(`OpenAI webhook ${webhook.id}: url ${webhook.url} → ${webhookUrl}`);
  if (!DRY) await openai.webhooks.update(webhook.id, { url: webhookUrl });
}
console.log(`\nCalls to ${number.phone_number} now go to OpenAI SIP and ${webhookUrl}. Undo: bun scripts/direct-sip.ts off`);
