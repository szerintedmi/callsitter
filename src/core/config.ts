import { z } from "zod";
import { CODECS } from "./audio";

// Config schemas for the YAML files in config/. Runtime-agnostic: loading is done
// by an adapter implementing ConfigSource.
//
//   live.yaml        the voice agent at call start: voice, greeting, prompt
//   jev.yaml         everything Jev sees: context, questions and their answers
//   luna.yaml        everything about Luna: prompts, tools, limits
//   call-flow.yaml   what happens: timing, silence, and rules over Jev's answers
//   connection.yaml  how the call's audio reaches the agent (OpenAI SIP or Telnyx media stream)
//   cost.yaml        rough per-call cost estimate
//   public.yaml      the public "Scam me" page: limits that cap what strangers can spend
//   telegram.yaml    the owner's Telegram: a status message per call, and steering the call from it

/** gpt-live-1 built-in voices (openai BuiltInVoice in resources/live/live.d.ts). */
export const LIVE_VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
  "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;

export const LiveConfig = z.object({
  model: z.string().default("gpt-live-1"),
  // Built-in voice name, or a custom voice as { id: "voice_…" }. Fixed per call (Live can't
  // change it after session.start), so edits apply from the next call.
  voice: z.union([z.enum(LIVE_VOICES), z.object({ id: z.string().min(1) })]).default("marin"),
  greeting: z.string().min(1),
  // The session's system prompt. Everything later reaches Live as call-flow tell_live texts or
  // Luna guidance.
  instructions: z.string().min(1),
});

const labelName = z.string().regex(/^[a-z0-9_]+$/, "use lower_snake_case");
const unit = z.number().min(0).max(1);
/** A Jev Choice: the prompt and each answer's label → description. */
const ChoiceQuestion = z.object({
  prompt: z.string().min(1),
  labels: z.record(labelName, z.string().min(1)).refine((l) => Object.keys(l).length >= 2, "needs at least 2 labels"),
});

export const JevConfig = z.object({
  model: z.string().default("jev-latest"),
  timeout_ms: z.number().int().positive().default(1500),
  // The line Jev's transcript gets where the owner's last summary was written (luna.yaml
  // progress); prompts refer to it as {owner_update_marker}.
  owner_update_marker: z.string().min(1).default("--- last update sent to {owner_name} ---"),
  // Free-text context sent with the transcript as part of the Jev state.
  context: z.string().default(""),
  // Asked in one systemOne call on every tick. verdict and urgency are stored with
  // the call; every other question is a Choice that call-flow.yaml rules can refer to.
  questions: z
    .object({
      // Noul answers carry no confidence, so the verdict is a Choice and its probabilities give
      // the confidence. `unclear` = not enough to go on yet.
      verdict: z.object({
        prompt: z.string().min(1),
        labels: z.object({ scam: z.string(), spam: z.string(), genuine: z.string(), unclear: z.string() }),
      }),
      // Score levels, lowest first (2–10 levels). Normalised to 0..1.
      urgency: z.object({ prompt: z.string().min(1), levels: z.array(z.string()).min(2).max(10) }),
    })
    .catchall(ChoiceQuestion),
});

export const LunaTool = z.enum(["end_call"]);

export const LunaConfig = z.object({
  model: z.string().default("gpt-6-luna"),
  reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"),
  // Responses API service_tier for mid-call guidance (the end-of-call summary always uses auto).
  // priority (= "fast") is lower latency at a higher price; flex is cheaper and slower.
  // https://developers.openai.com/api/docs/guides/fast-mode
  service_tier: z.enum(["auto", "default", "priority", "fast", "flex"]).default("auto"),
  tools: z.array(LunaTool).default(["end_call"]),
  // Guards on ask_luna: at most max_calls per call, at least cooldown_ms apart, and only
  // when the caller has said something new.
  limits: z
    .object({
      max_calls: z.number().int().min(0).default(4),
      cooldown_ms: z.number().int().min(0).default(15000),
    })
    .default({ max_calls: 4, cooldown_ms: 15000 }),
  instructions: z.string().min(1),
  summarize_on_hangup: z.boolean().default(true),
  summary_instructions: z
    .string()
    .default("Summarise this phone call for the owner in 2–3 sentences: who called, what they wanted, and whether it was a scam."),
  // Rolling summary and the caller's open questions for the owner's Telegram status message.
  // Due when Jev's answer to `when` reaches min (at most every min_interval_ms), or after
  // max_interval_ms if the caller said anything since. Never reaches Live and isn't counted in
  // limits.max_calls.
  progress: z
    .object({
      enabled: z.boolean().default(true),
      when: z
        .strictObject({ question: labelName, answer: labelName, min: unit })
        .default({ question: "owner_update", answer: "new", min: 0.8 }),
      min_interval_ms: z.number().int().min(1000).default(5000),
      max_interval_ms: z.number().int().min(1000).nullable().default(30000),
      reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"),
      instructions: z
        .string()
        .default("Summarise this phone call so far for the owner in 1–2 sentences, and list what the caller asked that only the owner can answer."),
    })
    .prefault({}),
  // After hangup, a running Luna call may finish (so the summary sees it) for up to this
  // long before it's cancelled.
  drain_timeout_ms: z.number().int().min(0).default(20000),
});

/**
 * How a text reaches Live (openai resources/live/live.d.ts), each ≤ 500 tokens. Measured on
 * gpt-live-1 (call-flow.yaml has the details):
 *   commentary    session.commentary.append: the agent acts on it and speaks at once, in its own
 *                 words, without being cut off
 *   instructions  session.instructions.append: redirects the agent but cuts off its speech; an
 *                 idle agent mostly waits for the caller's next turn
 *   thinking      session.thinking.append: silent context; can shape later speech, doesn't prompt it
 */
export const LIVE_APPENDS = ["instructions", "thinking", "commentary"] as const;
export type LiveAppend = (typeof LIVE_APPENDS)[number];
/** instructions.append is limited to ~500 tokens; stay well under */
export const MAX_APPEND_CHARS = 1800;

/**
 * When a text is sent (measured on gpt-live-1: an instructions append cuts off what the agent is
 * saying, and a reply it is about to give; thinking and commentary appends don't):
 *   now              at once, even if that cuts the agent off
 *   when_agent_idle  once the agent isn't speaking or about to reply (timing.agent_idle), or
 *                    after max_hold_ms (null: no limit)
 */
export const SEND_MODES = ["now", "when_agent_idle"] as const;
export type SendMode = (typeof SEND_MODES)[number];

/** Filled with Luna's reply in the tell_live text of an ask_luna rule. */
export const LUNA_RESPONSE = "{luna_response}";
/** Filled with the owner's Telegram message in telegram.yaml steering.text. */
export const OWNER_MESSAGE = "{owner_message}";

/** The owner's steering text as Live gets it: in telegram.yaml steering.text, within the append limit. */
export function ownerAppendText(st: TelegramConfig["steering"], text: string): string {
  return st.text.replace(OWNER_MESSAGE, () => text).slice(0, MAX_APPEND_CHARS);
}
/** The time a prompt is sent, e.g. "Fri 2026-Sep-25 19:10 BST"; only in the texts of CURRENT_TIME_TEXTS */
export const CURRENT_TIME = "{current_time}";
/** Filled each time they're sent: Live's at call start, Jev's per classification, Luna's per run. */
const CURRENT_TIME_TEXTS = ["live.instructions", "jev.context", "luna.instructions"];

// UK time, like the phone the prompts describe. en-GB names the zone BST or GMT.
const UK_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  year: "numeric",
  month: "numeric",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Fills {current_time} with `ms` (epoch) as UK time, e.g. "Fri 2026-Sep-25 19:10 BST". */
export function fillCurrentTime(text: string, ms: number): string {
  if (!text.includes(CURRENT_TIME)) return text;
  const p = Object.fromEntries(UK_TIME.formatToParts(ms).map((x) => [x.type, x.value]));
  const time = `${p.weekday} ${p.year}-${MONTHS[Number(p.month) - 1]}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  return text.replaceAll(CURRENT_TIME, time);
}

/** How a text is sent; defaults.tell_live sets them for every tell_live. */
const delivery = {
  send: z.enum(SEND_MODES).optional(),
  max_hold_ms: z.number().int().min(0).nullable().optional(),
};
const noHoldWhenNow = (t: { send?: SendMode; max_hold_ms?: number | null }) => !(t.send === "now" && t.max_hold_ms !== undefined);
const NO_HOLD_WHEN_NOW = { message: "max_hold_ms only applies to send: when_agent_idle", path: ["max_hold_ms"] };

/** A text for Live, always saying which kind of append it is. */
const TellLiveInput = z
  .strictObject({
    as: z.enum(LIVE_APPENDS),
    text: z.string().min(1).max(MAX_APPEND_CHARS),
    ...delivery,
  })
  .refine(noHoldWhenNow, NO_HOLD_WHEN_NOW);

/** A tell_live with defaults.tell_live applied. */
export interface TellLive {
  as: LiveAppend;
  text: string;
  send: SendMode;
  max_hold_ms: number | null;
}

const oneOrMany = z.union([labelName, z.array(labelName).min(1)]);

/**
 * A condition on one Jev question:
 *   answer | [answers]              Jev's chosen answer is one of these
 *   { is: answers, min: 0.75 }      Jev's probabilities for these answers add up to at least min
 *   { unsure: 0.4 }                 Jev's chosen answer has a probability below this
 */
const Condition = z.union([
  oneOrMany,
  z.strictObject({ is: oneOrMany, min: unit.optional() }),
  z.strictObject({ unsure: unit }),
]);

const Rule = z
  .strictObject({
    // The rule's name. When it tells Live something, the call enters this stage.
    stage: labelName,
    // All must hold. `stage: …` checks the call's current stage (`none` before any);
    // `urgency: { min }` Jev's urgency score (0..1).
    when: z.record(z.string(), z.unknown()).default({}),
    // Omitted: the flow stops here and does nothing.
    then: z
      .strictObject({
        // Asks Luna first; her reply fills {luna_response} in tell_live.text. Luna is asked again
        // whenever the caller has said something new, within luna.yaml limits.
        ask_luna: z.literal(true).optional(),
        // Appended to the Live session as `as`; the call enters this stage. A fixed text isn't
        // re-sent while the call is in this stage.
        tell_live: TellLiveInput.optional(),
        hang_up: z.literal(true).optional(),
      })
      .superRefine((t, ctx) => {
        const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: "custom", message, path });
        if (t.hang_up && (t.tell_live || t.ask_luna)) issue("hang_up can't be combined with tell_live or ask_luna");
        if (!t.hang_up && !t.tell_live && !t.ask_luna) issue("needs tell_live, ask_luna or hang_up");
        const hasResponse = t.tell_live?.text.includes(LUNA_RESPONSE);
        if (t.tell_live && t.ask_luna && !hasResponse) issue(`with ask_luna, the text needs ${LUNA_RESPONSE}`, ["tell_live", "text"]);
        if (hasResponse && !t.ask_luna) issue(`${LUNA_RESPONSE} needs ask_luna`, ["tell_live", "text"]);
      })
      .optional(),
  })
  .transform((r, ctx) => {
    const when: Record<string, z.infer<typeof Condition>> = {};
    let inStage: string[] | undefined;
    let minUrgency: number | undefined;
    for (const [key, value] of Object.entries(r.when)) {
      if (key === "urgency") {
        const u = z.strictObject({ min: unit }).safeParse(value);
        if (u.success) minUrgency = u.data.min;
        else ctx.addIssue({ code: "custom", path: ["when", key], message: "expected { min: 0..1 } (urgency is a score)" });
        continue;
      }
      if (key === "stage") {
        const s = oneOrMany.safeParse(value);
        if (s.success) inStage = typeof s.data === "string" ? [s.data] : s.data;
        else ctx.addIssue({ code: "custom", path: ["when", key], message: "expected a stage, a list of them, or none" });
        continue;
      }
      const c = Condition.safeParse(value);
      if (c.success) when[key] = c.data;
      else ctx.addIssue({ code: "custom", path: ["when", key], message: "expected an answer, a list of answers, { is, min } or { unsure }" });
    }
    return { stage: r.stage, when, inStage, minUrgency, then: r.then };
  });

/** The stage timing.time_up puts the call in. */
export const TIME_UP = "time_up";

export const CallFlowConfig = z
  .object({
    // Every tell_live key except as and text. Applied when the config loads.
    defaults: z
      .object({
        tell_live: z
          .strictObject({
            send: z.enum(SEND_MODES).default("when_agent_idle"),
            // Never hold a text longer than this (e.g. constant noise counted as speech); null: no limit.
            max_hold_ms: z.number().int().min(0).nullable().default(8000),
          })
          .prefault({}),
      })
      .prefault({}),
    // Frames the flow: when Jev runs, when the agent counts as idle, and the call length cap.
    timing: z
      .object({
        max_call_seconds: z.number().int().positive().default(900),
        // With seconds_left of max_call_seconds to go, the call enters the time_up stage and Live is
        // told tell_live (say goodbye). At max_call_seconds the call ends once the goodbye has
        // played. Omitted: the call just ends at max_call_seconds.
        time_up: z
          .strictObject({
            seconds_left: z.number().int().positive(),
            tell_live: TellLiveInput,
          })
          .optional(),
        // Jev runs once the caller pauses, and periodically during long monologues.
        classify: z
          .object({
            // No new caller words for this long = end of their turn → classify.
            settle_ms: z.number().int().min(100).default(600),
            // While the caller keeps talking, classify at least this often.
            max_wait_ms: z.number().int().min(500).default(4000),
            // A failed Jev call is retried after retry_min_ms, doubling on each failure up to retry_max_ms.
            retry_min_ms: z.number().int().min(100).default(500),
            retry_max_ms: z.number().int().min(100).default(8000),
          })
          .default({ settle_ms: 600, max_wait_ms: 4000, retry_min_ms: 500, retry_max_ms: 8000 }),
        // When the agent counts as idle, for send: when_agent_idle: not speaking, and not about to
        // reply to the caller.
        agent_idle: z
          .object({
            // After the caller stops, wait this long for the agent to start replying.
            reply_window_ms: z.number().int().min(0).default(3000),
            // The agent counts as still speaking this long after its last audio: Live pauses briefly
            // between phrases, and an append in such a pause cut the sentence off.
            agent_pause_ms: z.number().int().min(0).default(1000),
            // A hangup waits for the agent's goodbye to play out (the agent idle), but at most this long.
            max_hangup_wait_ms: z.number().int().min(0).default(8000),
          })
          .default({ reply_window_ms: 3000, agent_pause_ms: 1000, max_hangup_wait_ms: 8000 }),
      })
      .default({
        max_call_seconds: 900,
        classify: { settle_ms: 600, max_wait_ms: 4000, retry_min_ms: 500, retry_max_ms: 8000 },
        agent_idle: { reply_window_ms: 3000, agent_pause_ms: 1000, max_hangup_wait_ms: 8000 },
      }),
    // gpt-live-1 waits quietly when nobody speaks and has no idle setting, so the server nudges it.
    silence: z
      .object({
        enabled: z.boolean().default(true),
        // No caller speech and no agent audio for this long → tell_live.
        after_ms: z.number().int().min(2000).default(7000),
        tell_live: TellLiveInput.default({
          as: "commentary",
          text: "The caller has stopped talking. Speak now: if their last words still need a reply, reply to them; otherwise briefly check they're still there, e.g. \"Hello? Are you still there?\" If they start talking, stop and listen.",
        }),
        max_prompts: z.number().int().min(0).default(2),
        // After max_prompts unanswered prompts and one more silent period, hang up.
        hang_up: z.boolean().default(true),
        // In these stages the first silent period ends the call instead of prompting the caller
        // (e.g. once the goodbyes are said). Jev only runs on caller speech, so it can't see this.
        hang_up_in: z.array(labelName).default([]),
      })
      .prefault({}),
    // Checked top to bottom after every Jev call; the first rule whose `when` holds runs.
    rules: z.array(Rule).min(1),
    // Live asked for help itself (session.delegation.created): Luna's reply fills
    // {luna_response}. Live is waiting, so it always gets an answer: `fallback` when Luna has
    // none, is over her limits, or the call moved on.
    when_live_asks_for_help: z
      .strictObject({
        tell_live: TellLiveInput.default({ as: "commentary", text: "SUPERVISOR: {luna_response}" }),
        fallback: z.string().min(1).max(MAX_APPEND_CHARS).default("No specific guidance; carry on naturally."),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    if (!c.when_live_asks_for_help.tell_live.text.includes(LUNA_RESPONSE)) {
      ctx.addIssue({ code: "custom", path: ["when_live_asks_for_help", "tell_live", "text"], message: `needs ${LUNA_RESPONSE}` });
    }
    for (const [path, text] of [
      [["silence", "tell_live", "text"], c.silence.tell_live.text],
      [["when_live_asks_for_help", "fallback"], c.when_live_asks_for_help.fallback],
      [["timing", "time_up", "tell_live", "text"], c.timing.time_up?.tell_live.text ?? ""],
    ] as const) {
      if (text.includes(LUNA_RESPONSE)) ctx.addIssue({ code: "custom", path: [...path], message: `${LUNA_RESPONSE} is only filled in with ask_luna` });
    }
    const names = new Set<string>();
    for (const [i, r] of c.rules.entries()) {
      if (r.stage === "none") ctx.addIssue({ code: "custom", path: ["rules", i, "stage"], message: "`none` is reserved" });
      if (names.has(r.stage)) ctx.addIssue({ code: "custom", path: ["rules", i, "stage"], message: `duplicate stage ${r.stage}` });
      names.add(r.stage);
    }
    if (names.has(TIME_UP)) ctx.addIssue({ code: "custom", path: ["rules"], message: `${TIME_UP} is reserved for timing.time_up` });
    // Only tell_live (and timing.time_up) moves the call into a stage, so only those can be checked for.
    const stages = new Set(["none", ...c.rules.filter((r) => r.then?.tell_live !== undefined).map((r) => r.stage)]);
    if (c.timing.time_up) stages.add(TIME_UP);
    for (const [i, r] of c.rules.entries()) {
      for (const s of r.inStage ?? []) {
        if (!stages.has(s)) {
          ctx.addIssue({ code: "custom", path: ["rules", i, "when", "stage"], message: `${s} is not none or a stage with tell_live` });
        }
      }
    }
    for (const [i, s] of c.silence.hang_up_in.entries()) {
      if (s === "none" || !stages.has(s)) ctx.addIssue({ code: "custom", path: ["silence", "hang_up_in", i], message: `${s} is not a stage with tell_live` });
    }
  })
  .transform(({ defaults, ...c }) => {
    const d = defaults.tell_live;
    const tell = (t: z.infer<typeof TellLiveInput>): TellLive => ({
      as: t.as,
      text: t.text,
      send: t.send ?? d.send,
      max_hold_ms: t.max_hold_ms === undefined ? d.max_hold_ms : t.max_hold_ms,
    });
    const help = c.when_live_asks_for_help;
    const helpTell = tell(help.tell_live);
    const tu = c.timing.time_up;
    return {
      ...c,
      timing: { ...c.timing, time_up: tu ? { ...tu, tell_live: tell(tu.tell_live) } : undefined },
      silence: { ...c.silence, tell_live: tell(c.silence.tell_live) },
      rules: c.rules.map((r) => ({
        ...r,
        then: r.then && { ...r.then, tell_live: r.then.tell_live && tell(r.then.tell_live) },
      })),
      when_live_asks_for_help: { tell_live: helpTell, fallback: { ...helpTell, text: help.fallback } },
    };
  });

/** A rule with defaults.tell_live applied. */
export type Rule = CallFlowConfig["rules"][number];
export type Condition = z.infer<typeof Condition>;

const NOISE_SUPPRESSION_DEFAULTS = { enabled: true, engine: "Denoiser" as const, direction: "outbound" as const };
const NoiseSuppressionConfig = z.object({
  enabled: z.boolean().default(true),
  // Telnyx suppression_start engines (BETA): Denoiser $0.002/min, AiCoustics $0.003, Krisp $0.005.
  engine: z.enum(["Denoiser", "DeepFilterNet", "Krisp", "AiCoustics"]).default("Denoiser"),
  // Telnyx: `outbound` = audio received from the caller (what Live hears); `inbound` = what
  // the caller hears. Their docs recommend `outbound` for streaming/AI.
  direction: z.enum(["outbound", "inbound", "both"]).default("outbound"),
});

const SIP_DEFAULTS = { enabled: true, region: "global" as const, record: true, reject_status: 480, test_greeting_wait_ms: 3000 };
const SipConfig = z.object({
  // Answer calls that reach OpenAI's SIP endpoint (live.transport.incoming). When false they
  // are rejected with reject_status, so the carrier can fail over.
  enabled: z.boolean().default(true),
  // OpenAI SIP endpoint the carrier and the browser SIP test dial: global = sip.api.openai.com,
  // eu = sip-eu.api.openai.com (EU data residency).
  region: z.enum(["global", "eu"]).default("global"),
  // Record the call from the sideband's reflected audio (stereo 24 kHz WAV: caller left, agent right).
  record: z.boolean().default(true),
  // SIP status for rejected calls (300–699). 480 = temporarily unavailable.
  reject_status: z.number().int().min(300).max(699).default(480),
  // Browser SIP test: Live greets once the page reports its WebRTC audio connected, or after
  // this long. OpenAI answers before the browser can hear, so an immediate "Hello?" gets lost.
  test_greeting_wait_ms: z.number().int().min(0).max(10_000).default(3000),
});

export const ConnectionConfig = z.object({
  // OpenAI SIP: the carrier sends the call straight to gpt-live-1 and we attach a sideband.
  // Needs OPENAI_PROJECT_ID and OPENAI_WEBHOOK_SECRET in .env (README → OpenAI SIP).
  sip: SipConfig.default(SIP_DEFAULTS),
  // Telnyx media stream: Telnyx answers and relays the audio to us, we relay it to Live.
  media_stream: z
    .object({
      codec: z.enum(CODECS).default("pcmu"),
      noise_suppression: NoiseSuppressionConfig.default(NOISE_SUPPRESSION_DEFAULTS),
    })
    .default({ codec: "pcmu", noise_suppression: NOISE_SUPPRESSION_DEFAULTS }),
  // Live (for OpenAI SIP: the accept and the sideband) must be up within this long of answering,
  // or the call is hung up. The call's max_call_seconds also runs from answer.
  connect_timeout_ms: z.number().int().positive().default(10000),
  // How long ending a call waits for the carrier's hangup request before closing the session
  // anyway (the request carries on in the background).
  hangup_timeout_ms: z.number().int().positive().default(5000),
  // What counts as speech (RMS dBFS per 20 ms frame), for the silence watchdog and the recorded
  // greeting. Transcripts arrive seconds late, so the watchdog listens to the audio instead.
  speech_detection: z
    .object({
      caller_dbfs: z.number().max(0).default(-40),
      // Live pads pauses with digital silence but also sends faint noise (-60 to -80 dBFS).
      agent_dbfs: z.number().max(0).default(-50),
    })
    .default({ caller_dbfs: -40, agent_dbfs: -50 }),
});

export const CostConfig = z.object({
  live_usd_per_min: z.number().min(0).default(0.05),
  // Luna's prices per 1M tokens; a response's service tier multiplies them.
  luna: z
    .object({
      input_usd_per_mtok: z.number().min(0).default(0.1),
      cached_input_usd_per_mtok: z.number().min(0).default(0.01),
      cache_write_usd_per_mtok: z.number().min(0).default(0.125),
      output_usd_per_mtok: z.number().min(0).default(0.5),
      tier_multipliers: z.record(z.string(), z.number().min(0)).default({ priority: 2, fast: 2, flex: 0.5 }),
    })
    .prefault({}),
  // Only for the public page's worst-case budget check (calls are priced from their tokens).
  luna_usd_per_call: z.number().min(0).default(0.01),
  jev_usd_per_mtok: z.number().min(0).default(0.042),
});

// The public page (src/web/public.ts): anyone with the link can call, so these bound the cost.
export const PublicConfig = z.object({
  enabled: z.boolean().default(true),
  // Public calls end after this long, whatever the call flow says (flow.timing.max_call_seconds
  // still applies if it is shorter).
  max_call_seconds: z.number().int().positive().default(300),
  max_concurrent: z.number().int().min(0).default(3),
  // Estimated spend (cost.yaml) on public calls over a rolling 24 h. A new call is admitted only
  // if it fits even if it and every live public call run to max_call_seconds.
  daily_usd: z.number().min(0).default(10),
  // Calls per client IP (Cloudflare's CF-Connecting-IP) over a rolling 24 h; kept in memory, so a
  // restart resets it.
  per_ip_per_day: z.number().int().min(0).default(10),
  // Luna's tools are live on public calls: she can end the call. false: they run dry, as on admin
  // test calls.
  tools: z.boolean().default(true),
  // Live greets once the page reports its audio connected, or after this long.
  greeting_wait_ms: z.number().int().min(0).max(10_000).default(3000),
});

// The owner's Telegram (TELEGRAM_* in .env): one status message per call, edited as it goes on,
// and steering: the owner's messages reach Live as steering.text.
export const TelegramConfig = z.object({
  status: z
    .object({
      enabled: z.boolean().default(true),
      // Telegram allows about one message per second in a chat, edits included.
      min_edit_interval_ms: z.number().int().min(1000).default(3000),
      // A notifying reply to the status message when Jev says the call is urgent, once per call,
      // unless Jev's scam + spam probability is at least unless_junk; with luna, also when Luna's
      // rolling summary says so (luna.yaml progress: alert).
      urgent_alert: z
        .object({
          enabled: z.boolean().default(true),
          min_urgency: unit.default(0.7),
          unless_junk: unit.default(0.75),
          luna: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  steering: z
    .object({
      enabled: z.boolean().default(true),
      // the owner's messages older than this are ignored (sent while the server was down)
      stale_after_ms: z.number().int().positive().default(60_000),
      default: z.enum(LIVE_APPENDS).default("commentary"),
      // first character(s) of a message → how it reaches Live instead of `default`
      prefixes: z.record(z.string().min(1).max(4).regex(/^\S+$/, "no spaces"), z.enum(LIVE_APPENDS)).default({ "!": "instructions", "~": "thinking" }),
      text: z
        .string()
        .min(1)
        .max(1000)
        .default(`SUPERVISOR: ${OWNER_MESSAGE}`)
        .refine((t) => t.includes(OWNER_MESSAGE), `needs ${OWNER_MESSAGE}`),
      // Buttons under a live call's status message; a tap sends `text` as `as`.
      buttons: z
        .array(z.strictObject({ label: z.string().min(1).max(30), text: z.string().min(1).max(500), as: z.enum(LIVE_APPENDS).default("thinking") }))
        .max(8)
        .default([]),
      // Luna's suggested buttons (luna.yaml progress: suggestions), one per row below `buttons`,
      // replaced with each rolling summary; a tap sends the suggestion's text as `as`.
      suggestions: z.object({ enabled: z.boolean().default(true), as: z.enum(LIVE_APPENDS).default("commentary") }).prefault({}),
    })
    .prefault({}),
});

export type LiveConfig = z.infer<typeof LiveConfig>;
export type JevConfig = z.infer<typeof JevConfig>;
export type LunaTool = z.infer<typeof LunaTool>;
export type LunaConfig = z.infer<typeof LunaConfig>;
export type CallFlowConfig = z.infer<typeof CallFlowConfig>;
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;
export type CostConfig = z.infer<typeof CostConfig>;
export type PublicConfig = z.infer<typeof PublicConfig>;
export type TelegramConfig = z.infer<typeof TelegramConfig>;

export interface AppConfig {
  live: LiveConfig;
  jev: JevConfig;
  luna: LunaConfig;
  flow: CallFlowConfig;
  connection: ConnectionConfig;
  cost: CostConfig;
  public: PublicConfig;
  telegram: TelegramConfig;
}

const schemas = {
  live: LiveConfig,
  jev: JevConfig,
  luna: LunaConfig,
  flow: CallFlowConfig,
  connection: ConnectionConfig,
  cost: CostConfig,
  public: PublicConfig,
  telegram: TelegramConfig,
} as const;

export type ConfigName = keyof typeof schemas;
export const CONFIG_NAMES = Object.keys(schemas) as ConfigName[];
/** The YAML file each config is read from. */
export const CONFIG_FILES: Record<ConfigName, string> = {
  live: "live.yaml",
  jev: "jev.yaml",
  luna: "luna.yaml",
  flow: "call-flow.yaml",
  connection: "connection.yaml",
  cost: "cost.yaml",
  public: "public.yaml",
  telegram: "telegram.yaml",
};

/** Supplies the raw (already YAML-parsed) value for each config file. */
export interface ConfigSource {
  read(name: ConfigName): Promise<unknown>;
}

export class ConfigError extends Error {}

export function parseConfig<N extends ConfigName>(name: N, raw: unknown): z.infer<(typeof schemas)[N]> {
  const res = (schemas[name] as unknown as z.ZodType<z.infer<(typeof schemas)[N]>>).safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues
      .map((i) => `  ${CONFIG_FILES[name]}: ${issuePath(raw, i.path) || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config:\n${issues}`);
  }
  return res.data;
}

/** "rules.4.when" → "rules[wrap_up].when": rules are easier to find by stage. */
function issuePath(raw: unknown, path: readonly PropertyKey[]): string {
  const rules = (raw as { rules?: { stage?: unknown }[] } | null)?.rules;
  return path
    .map((p, i) => {
      const name = i === 1 && path[0] === "rules" && typeof p === "number" ? rules?.[p]?.stage : undefined;
      return typeof name === "string" ? `[${name}]` : `${i ? "." : ""}${String(p)}`;
    })
    .join("");
}

/** The Choice questions a rule can refer to, as question → its answers. */
export function choiceQuestions(jev: JevConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, q] of Object.entries(jev.questions)) {
    if (name === "urgency") continue;
    out.set(name, Object.keys((q as { labels: object }).labels));
  }
  return out;
}

/** Checks call-flow.yaml against jev.yaml: every question and answer a rule names must exist. */
export function checkFlow(flow: CallFlowConfig, jev: JevConfig): void {
  const questions = choiceQuestions(jev);
  const issues: string[] = [];
  const at = (i: number, path: string, msg: string) => issues.push(`  call-flow.yaml: rules[${flow.rules[i]!.stage}].${path}: ${msg}`);
  const checkAnswers = (i: number, path: string, q: string, answers: string | string[]) => {
    for (const a of typeof answers === "string" ? [answers] : answers) {
      if (!questions.get(q)!.includes(a)) at(i, path, `${a} is not an answer of jev.yaml questions.${q}`);
    }
  };
  for (const [i, r] of flow.rules.entries()) {
    for (const [q, c] of Object.entries(r.when)) {
      if (!questions.has(q)) {
        at(i, `when.${q}`, `no Choice question ${q} in jev.yaml (have: ${[...questions.keys()].join(", ")})`);
        continue;
      }
      if (typeof c === "string" || Array.isArray(c)) checkAnswers(i, `when.${q}`, q, c);
      else if ("is" in c) checkAnswers(i, `when.${q}.is`, q, c.is);
    }
  }
  if (issues.length) throw new ConfigError(`Invalid config:\n${issues.join("\n")}`);
}

/** Checks luna.yaml progress.when against jev.yaml: it must name a Choice question and one of its answers. */
export function checkProgress(luna: LunaConfig, jev: JevConfig): void {
  const w = luna.progress.when;
  if (!luna.progress.enabled) return;
  const answers = choiceQuestions(jev).get(w.question);
  const issue = !answers
    ? `no Choice question ${w.question} in jev.yaml`
    : !answers.includes(w.answer)
      ? `${w.answer} is not an answer of jev.yaml questions.${w.question}`
      : null;
  if (issue) throw new ConfigError(`Invalid config:\n  luna.yaml: progress.when: ${issue}`);
}

/** Values for the {placeholders} config texts may use. */
export interface ConfigVars {
  /** OWNER_NAME; {owner_name} falls back to "the owner" */
  ownerName?: string;
  /** AGENT_LANGUAGES; {agent_languages} falls back to "English" */
  agentLanguages?: string;
}

/**
 * Fills {owner_name}, {agent_languages} and {owner_update_marker} (jev.yaml's, itself filled) in
 * every config text. Other placeholders are rejected, except
 * {luna_response} in call-flow.yaml (the schema checks where), which is filled with each Luna reply,
 * {owner_message} in telegram.yaml steering.text, filled with each of the owner's messages, and
 * {current_time} in CURRENT_TIME_TEXTS, filled as they're sent (fillCurrentTime).
 */
export function fillPlaceholders(cfg: AppConfig, vars: ConfigVars = {}): AppConfig {
  const values: Record<string, string> = {
    owner_name: vars.ownerName || "the owner",
    agent_languages: vars.agentLanguages || "English",
  };
  values.owner_update_marker = cfg.jev.owner_update_marker.replace(/\{(owner_name|agent_languages)\}/g, (_, k: string) => values[k]!);
  const issues: string[] = [];
  const where = (path: string[]) => {
    const [name, ...rest] = path as [ConfigName, ...string[]];
    // flow.rules.3.then.tell_live → rules[wrap_up].then.tell_live
    if (name === "flow" && rest[0] === "rules") rest.splice(0, 2, `rules[${cfg.flow.rules[Number(rest[1])]?.stage}]`);
    return `${CONFIG_FILES[name]}: ${rest.join(".")}`;
  };
  const walk = (v: unknown, path: string[]): unknown => {
    if (typeof v === "string") {
      return v.replace(/\{([a-z_]+)\}/g, (m, key: string) => {
        if (key in values) return values[key]!;
        const at = path.join(".");
        const later =
          (m === LUNA_RESPONSE && path[0] === "flow") ||
          (m === OWNER_MESSAGE && at === "telegram.steering.text") ||
          (m === CURRENT_TIME && CURRENT_TIME_TEXTS.includes(at));
        if (!later) {
          issues.push(`  ${where(path)}: unknown placeholder ${m} (known: ${Object.keys(values).map((k) => `{${k}}`).join(", ")})`);
        }
        return m;
      });
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
    return v;
  };
  const out = walk(cfg, []) as AppConfig;
  if (issues.length) throw new ConfigError(`Invalid config:\n${issues.join("\n")}`);
  return out;
}

export async function loadConfig(source: ConfigSource, vars: ConfigVars = {}): Promise<AppConfig> {
  const entries = await Promise.all(
    CONFIG_NAMES.map(async (n) => [n, parseConfig(n, await source.read(n))] as const),
  );
  const cfg = Object.fromEntries(entries) as unknown as AppConfig;
  checkFlow(cfg.flow, cfg.jev);
  checkProgress(cfg.luna, cfg.jev);
  return fillPlaceholders(cfg, vars);
}

/** Holds the current config; swapped atomically on hot reload. */
export class ConfigStore {
  private listeners = new Set<(next: AppConfig) => void>();
  constructor(private current: AppConfig) {}
  get(): AppConfig {
    return this.current;
  }
  set(next: AppConfig) {
    this.current = next;
    for (const fn of this.listeners) fn(next);
  }
  /** Called after every reload; returns an unsubscribe function. */
  onChange(fn: (next: AppConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
