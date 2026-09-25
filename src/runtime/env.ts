import { z } from "zod";
import type { UiAuth } from "../web/ui-guard";

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  BIND_HOST: z.string().default("127.0.0.1"),
  /** wss:// base Telnyx connects to for media, e.g. wss://hooks.example.com */
  PUBLIC_WS_BASE: z.string().regex(/^wss?:\/\/[^/]+$/, "e.g. wss://hooks.example.com (no trailing slash)"),
  TELNYX_API_KEY: z.string().min(1),
  /** Mission Control → Keys & Credentials → Public Key (base64) */
  TELNYX_PUBLIC_KEY: z.string().min(1),
  /** +447 number or alphanumeric sender ID; SMS to the owner is disabled when unset */
  TELNYX_SMS_FROM: z.string().trim().min(1).optional(),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1),
  /** OpenAI SIP: project the carrier dials (sip:proj_…@sip.api.openai.com); SIP is off unless both are set */
  OPENAI_PROJECT_ID: z.string().regex(/^proj_[A-Za-z0-9]+$/, "e.g. proj_abc123 (Settings → Project → General)").optional(),
  /** signing secret of the live.transport.incoming webhook (whsec_…) */
  OPENAI_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Telnyx telephony credential the browser SIP test logs in with (scripts/setup-sip.ts creates it) */
  TELNYX_SIP_CREDENTIAL_ID: z.string().min(1).optional(),
  /** its credential connection (parks the browser's calls; our webhook transfers them to OpenAI) */
  TELNYX_SIP_CONNECTION_ID: z.string().min(1).optional(),
  TYPESAFE_API_KEY: z.string().min(1),
  MEDIA_TOKEN_SECRET: z.string().min(32, "use at least 32 random characters"),
  OWNER_NUMBER: z.string().regex(/^\+[1-9][0-9]{6,14}$/, "E.164, e.g. +447700900123").optional(),
  /** first name callers may ask for; lets the voice agent and Luna recognise requests for the owner */
  OWNER_NAME: z.string().trim().optional(),
  /** languages the voice agent speaks, e.g. "English and Hungarian" */
  AGENT_LANGUAGES: z.string().trim().optional(),
  DATA_DIR: z.string().default("./data"),
  CONFIG_DIR: z.string().default("./config"),
  CONFIG_WATCH: z
    .enum(["true", "false"])
    .default(process.env.NODE_ENV === "production" ? "false" : "true")
    .transform((v) => v === "true"),
  /** `access`: UI only via Cloudflare Access on UI_HOST (JWT verified). `none`: loopback only, for local dev. */
  UI_AUTH: z.enum(["access", "none"]).default("access"),
  /** UI hostname, e.g. ui.example.com */
  UI_HOST: z.string().regex(/^[a-z0-9.-]+$/i, "hostname only, e.g. ui.example.com").optional(),
  /** Zero Trust team domain, e.g. myteam.cloudflareaccess.com */
  CF_ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/i, "e.g. myteam.cloudflareaccess.com").optional(),
  /** Access application AUD tag */
  CF_ACCESS_AUD: z.string().min(1).optional(),
}).superRefine((e, ctx) => {
  if (e.UI_AUTH === "access") {
    for (const k of ["UI_HOST", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"] as const) {
      if (!e[k]) ctx.addIssue({ code: "custom", path: [k], message: "required when UI_AUTH=access (or set UI_AUTH=none for local-only)" });
    }
  }
  if (!!e.OPENAI_PROJECT_ID !== !!e.OPENAI_WEBHOOK_SECRET) {
    ctx.addIssue({ code: "custom", path: ["OPENAI_WEBHOOK_SECRET"], message: "set both OPENAI_PROJECT_ID and OPENAI_WEBHOOK_SECRET for SIP, or neither" });
  }
  const hooksHost = hostOfWsBase(e.PUBLIC_WS_BASE);
  if (e.UI_HOST && hooksHost && e.UI_HOST.toLowerCase() === hooksHost) {
    ctx.addIssue({ code: "custom", path: ["UI_HOST"], message: "must differ from the public PUBLIC_WS_BASE host" });
  }
});

export type Env = z.infer<typeof Env>;

function hostOfWsBase(base: string): string | null {
  try {
    return new URL(base.replace(/^ws/, "http")).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function uiAuthFrom(env: Env): UiAuth {
  if (env.UI_AUTH === "none") return { mode: "none", uiHost: env.UI_HOST };
  return { mode: "access", uiHost: env.UI_HOST!, teamDomain: env.CF_ACCESS_TEAM_DOMAIN!, aud: env.CF_ACCESS_AUD! };
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  // `FOO=` in .env means "not set", so optional vars can be left blank.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const res = Env.safeParse(cleaned);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (.env):\n${issues}`);
  }
  return res.data;
}
