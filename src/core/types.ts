import type { LiveAppend } from "./config";

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

export interface CallMeta {
  callId: string;
  from: string;
  to: string;
  divertedFrom?: string;
  startedAt: number;
}

export type CallStatus = "ringing" | "active" | "ended";

/** Who asked Luna: a call-flow rule (on Jev's answers), Live itself (a delegation), or the after-call run. */
/** summary: the end-of-call summary, which ends with a summary event rather than a luna one */
export type LunaTrigger = "rule" | "delegation" | "after_call" | "summary";

/** What a text sent to Live answers: a rule's stage text, Luna's reply, the silence watchdog, or Live's delegation. */
export type AppendSource = "stage" | "luna" | "silence" | "delegation";

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
  | { type: "classification"; callId: string; at: number; classification: Classification; decision?: FlowDecision }
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
    }
  | { type: "tool"; callId: string; at: number; call: ToolCallRecord }
  | { type: "note"; callId: string; at: number; level: "info" | "warn" | "error"; message: string }
  /** `at` and `endedAt` are when the call was hung up, not when its wrap-up (Luna, summary) finished */
  | {
      type: "call.ended";
      callId: string;
      at: number;
      /** wall clock */
      endedAt: number;
      reason: string;
      costUsd: number;
      lunaCalls: number;
      jevTicks: number;
    }
  | { type: "summary"; callId: string; at: number; text: string }
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
    };

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
