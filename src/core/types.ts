import type { LiveAppend } from "./config";
import type { Channel } from "./limits";

export type Speaker = "caller" | "agent";

export interface TranscriptEntry {
  seq: number;
  speaker: Speaker;
  text: string;
  /** ms since call start */
  at: number;
  final: boolean;
  /** Live's item id for the utterance */
  itemId?: string;
  /** when Live closed the utterance (ms since call start) */
  endAt?: number;
  /** agent only: first agent audio this long after the caller's last transcribed words */
  replyMs?: number;
}

export type Verdict = "scam" | "spam" | "genuine" | "unclear";

/** Jev's answer to one Choice question. */
export interface Answer {
  choice: string;
  /** label → probability (0..1) */
  probabilities: Record<string, number>;
}

/** Runtime-agnostic classifier output. Adapters map vendor results onto this. */
export interface Classification {
  verdict: Verdict;
  /** 0..1 confidence in the verdict (scam and spam add up: both are junk) */
  confidence: number;
  /** 0..1, how urgent/important the call is for the owner */
  urgency: number;
  /** every Choice question's answer by question name (verdict and the jev.yaml extras) */
  answers: Record<string, Answer>;
  latencyMs: number;
  raw?: unknown;
}

/** Token usage of one model call (its responses summed), as the vendor reports it. */
export interface TokenUsage {
  model: string;
  /** the tier the request ran on (cost.yaml luna.tier_multipliers) */
  serviceTier?: string;
  /** all input tokens, including cached tokens and cache writes */
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** all output tokens, including reasoning */
  outputTokens: number;
  reasoningTokens: number;
}

/** TokenUsage with cost.yaml prices applied. */
export interface PricedUsage extends TokenUsage {
  costUsd: number;
}

/** What a call cost, by vendor; totalUsd is the call's costUsd. */
export interface CallCosts {
  /** Live bills per second of session */
  liveSeconds: number;
  liveUsd: number;
  /** every Luna call: guidance, rolling summaries and the end-of-call summary */
  lunaUsd: number;
  jevUsd: number;
  /** the carrier's bill for the phone leg (Telnyx call.cost), once it has arrived after the hangup */
  carrierUsd?: number;
  totalUsd: number;
  luna: { calls: number; inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number };
  jevInputTokens: number;
}

export interface CallMeta {
  callId: string;
  from: string;
  to: string;
  divertedFrom?: string;
  channel: Channel;
  /** turned away unanswered (limits.yaml): why, for the owner */
  declined?: string;
  startedAt: number;
}

export type CallStatus = "ringing" | "active" | "ended";

/**
 * Who ended a call: the screener (call flow, Luna, silence, time limits), the caller, the owner
 * from Telegram, OpenAI Live closing the session (safety filter, time limit, lost connection), or
 * the server (failed starts, restarts, errors). The end reason says the rest.
 */
export type EndedBy = "bot" | "caller" | "owner" | "live" | "system";

/** Who asked Luna: a call-flow rule (on Jev's answers) or Live itself (a delegation). */
/** summary: the end-of-call summary, which ends with a summary event rather than a luna one */
export type LunaTrigger = "rule" | "delegation" | "summary";

/**
 * What a text sent to Live answers: a rule's stage text, Luna's reply, the silence watchdog,
 * Live's delegation, or the owner steering the call from Telegram.
 */
export type AppendSource = "stage" | "luna" | "silence" | "delegation" | "owner";

/** What the call flow did with one Jev result. */
export interface FlowDecision {
  /** the matched rule, or null */
  rule: string | null;
  /** luna_deferred: queued until `atMs` (cooldown, or another Luna call running); luna_skipped: over her limits */
  action: "none" | "tell_live" | "luna" | "luna_deferred" | "luna_skipped" | "end_call";
  reason: string;
  atMs?: number;
}

/** Events published per call; persisted and pushed to the UI. */
export type CallEvent =
  | { type: "call.started"; callId: string; meta: CallMeta }
  | { type: "transcript"; callId: string; entry: TranscriptEntry }
  | {
      type: "classification";
      callId: string;
      at: number;
      classification: Classification;
      decision?: FlowDecision;
      /** Jev's answer to luna.yaml progress.when: the owner's summary is due when probability ≥ min */
      ownerUpdate?: { question: string; answer: string; probability: number; min: number };
    }
  /** a call-flow rule told Live something, moving the call into a new stage */
  | { type: "stage"; callId: string; at: number; stage: string; as?: LiveAppend }
  /**
   * A text reached Live (or was dropped: a newer decision superseded it). `heldMs`: how long it
   * waited for the agent to be idle.
   */
  | {
      type: "live.append";
      callId: string;
      at: number;
      as: LiveAppend;
      text: string;
      source: AppendSource;
      /** the rule's stage (stage texts and Luna replies to a rule) */
      stage?: string;
      heldMs: number;
      delegationId?: string;
      /** the delegation's fallback answer, sent instead of guidance that went stale or never came */
      fallback?: boolean;
      dropped?: boolean;
    }
  | { type: "luna.started"; callId: string; at: number; reason: string; trigger: LunaTrigger; delegationId?: string }
  /** Live's usage report: audio seconds so far and the share of its context window in use */
  | { type: "live.usage"; callId: string; at: number; seconds: number; contextRatio?: number }
  | {
      type: "luna";
      callId: string;
      at: number;
      reason: string;
      trigger?: LunaTrigger;
      instructions?: string;
      /** why Luna's reply wasn't sent to Live, if it wasn't */
      dropped?: string;
      toolCalls: ToolCallRecord[];
      usage?: PricedUsage;
    }
  | { type: "tool"; callId: string; at: number; call: ToolCallRecord }
  /** Luna's rolling summary for the owner (luna.yaml progress): the call so far, and the caller's open questions */
  | {
      type: "progress";
      callId: string;
      at: number;
      summary: string;
      questions: string[];
      /** steering buttons for the owner (missing on calls from before they existed) */
      suggestions?: Suggestion[];
      /** the owner may want to act while the caller is still on the line */
      alert?: boolean;
      /** why it ran: Jev's owner_update answer, or the fallback interval */
      reason: string;
      tookMs: number;
      usage?: PricedUsage;
    }
  | { type: "note"; callId: string; at: number; level: "info" | "warn" | "error"; message: string }
  /** `at` and `endedAt` are when the call was hung up, not when its wrap-up (Luna, summary) finished */
  | {
      type: "call.ended";
      callId: string;
      at: number;
      /** wall clock */
      endedAt: number;
      reason: string;
      /** missing on calls from before it was recorded */
      endedBy?: EndedBy;
      costUsd: number;
      /** Luna requests of every kind so far (guidance, rolling summaries), as costs.luna.calls */
      lunaCalls: number;
      jevTicks: number;
      /** by vendor, from the usage they reported (calls ended before this was recorded have none) */
      costs?: CallCosts;
    }
  | {
      type: "summary";
      callId: string;
      at: number;
      text: string;
      usage?: PricedUsage;
      /** the last rolling summary, reused: the caller said nothing new after it */
      reused?: boolean;
    }
  /** the call's final costs, once the end-of-call summary is priced in too (call.ended has them without it) */
  | { type: "costs"; callId: string; at: number; costs: CallCosts }
  | { type: "recording"; callId: string; at: number; path: string }
  | {
      type: "sip.headers";
      callId: string;
      at: number;
      /** who reported them: OpenAI's live.transport.incoming webhook, or Telnyx's call.initiated */
      source: "openai" | "telnyx";
      headers: SipHeader[];
      /** OpenAI: media protection negotiated on the SIP leg (srtp | rtp) */
      mediaSecurity?: string;
      /** Telnyx: the rest of call.initiated (party type, SIP URIs, codecs, session and leg ids), by field name */
      info?: Record<string, string>;
    }
  /** the carrier's account of the hangup (Telnyx call.hangup: cause, who hung up, SIP code, call quality), by field name */
  | { type: "carrier.hangup"; callId: string; at: number; source: "telnyx"; info: Record<string, string> }
  /**
   * The owner took the call over from Telegram (telegram.yaml takeover): the agent says the
   * handover line, then the call moves to the owner's page and the bot stops steering it.
   */
  | { type: "takeover.started"; callId: string; at: number }
  /** the owner's page hears the caller (the transferred leg's audio flows) */
  | { type: "takeover.live"; callId: string; at: number }
  /** the takeover didn't happen: the agent carries on, or the call ended (call.ended follows) */
  | { type: "takeover.failed"; callId: string; at: number; reason: string }
  /** the call's recording stopped (storage failed or fell behind), or couldn't be stored at the end */
  | { type: "recording.failed"; callId: string; at: number; reason: string };

/** A SIP INVITE header as a vendor reports it (untrusted call metadata). */
export interface SipHeader {
  name: string;
  value: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

/** A steering button Luna suggests to the owner: a tap sends `text` to the agent. */
export interface Suggestion {
  label: string;
  text: string;
}
