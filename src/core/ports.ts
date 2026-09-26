import type { AudioFormat } from "./audio";
import type { AppConfig, JevConfig, LiveAppend, LunaTool } from "./config";
import type { CallCosts, CallEvent, CallMeta, CallStatus, Classification, Speaker, Suggestion, TokenUsage, ToolCallRecord, TranscriptEntry } from "./types";

// Ports: everything core needs from the outside world. Adapters implement these.

/** REST-side call control (answer/record/hangup live in the webhook layer). */
export interface Telephony {
  hangup(callControlId: string): Promise<void>;
}

/** The media leg of one call (Telnyx media WebSocket). */
export interface MediaChannel {
  /** base64 audio in the negotiated codec */
  sendAudio(payloadB64: string): void;
  /** drop any audio queued for playback */
  clear(): void;
  close(): void;
}

export interface VoiceSessionHandlers {
  onAudio(payloadB64: string): void;
  /**
   * A copy of the caller's audio, when it reaches the vendor directly (OpenAI SIP sideband:
   * 24 kHz PCM16LE). For speech detection only; it is already on its way to the model.
   */
  onCallerAudio?(payloadB64: string): void;
  /** incremental transcript text for one utterance */
  onTranscriptDelta(speaker: Speaker, itemId: string, delta: string): void;
  /** utterance finished; `text` is the full final text if the vendor provides it */
  onTranscriptDone(speaker: Speaker, itemId: string, text?: string): void;
  /** caller started speaking over the agent */
  onInterrupt(): void;
  /** the voice model asked the client to handle something */
  onDelegation(req: DelegationRequest): void;
  /** the vendor's periodic usage report (Live: session.usage.updated, about once a minute) */
  onUsage?(usage: VoiceUsage): void;
  onError(err: Error): void;
  onClose(): void;
}

export interface VoiceUsage {
  /** cumulative audio seconds in the session */
  seconds: number;
  /** active context tokens / the model's context limit, when the vendor knows it; drops after compaction */
  contextRatio?: number;
}

/** Live delegation events carry only an id; the task comes from the transcript. */
export interface DelegationRequest {
  id: string;
}

export interface VoiceSessionOptions {
  config: AppConfig["live"];
  codec: AudioFormat;
  /**
   * The greeting was already played to the caller (a recording of this voice): the session
   * starts with it as the agent's first turn instead of being asked to say it.
   */
  greeted?: string;
  /** abandons the connection attempt (the call ended, or it took too long): connect() rejects */
  signal?: AbortSignal;
}

export interface VoiceSession {
  sendAudio(payloadB64: string): void;
  /** appends `text` to the session as instructions, thinking or commentary; with `delegationId` it answers that delegation */
  append(as: LiveAppend, text: string, delegationId?: string): void;
  /** resolves once the session has shut down (and handed over anything it recorded) */
  close(): Promise<void>;
}

export interface VoiceAgent {
  connect(opts: VoiceSessionOptions, handlers: VoiceSessionHandlers): Promise<VoiceSession>;
}

export interface ClassifierInput {
  meta: CallMeta;
  transcript: readonly TranscriptEntry[];
  config: JevConfig;
  signal?: AbortSignal;
  /** entries (by seq) the owner's last status update covered: Jev sees a marker line after them (jev.yaml owner_update) */
  ownerUpdatedThrough?: number;
}

export interface Classifier {
  classify(input: ClassifierInput): Promise<Classification>;
}

/** Tools that Luna can call; implemented by the orchestrator per call. */
export interface ToolContext {
  endCall(reason: string): Promise<string>;
}

export interface AgentInput {
  meta: CallMeta;
  transcript: readonly TranscriptEntry[];
  classification: Classification | null;
  reason: string;
  enabledTools: readonly LunaTool[];
  tools: ToolContext;
  signal?: AbortSignal;
  /** continue this call's agent conversation (from a previous AgentResult), so it sees its earlier guidance and tool calls */
  previousResponseId?: string;
  /** what the owner has told the agent from Telegram so far, oldest first */
  ownerMessages?: readonly string[];
}

/** A rolling summary for the owner while the call goes on. */
export interface Progress {
  summary: string;
  /** what the caller asked that only the owner can answer */
  questions: string[];
  /** steering buttons for the owner */
  suggestions: Suggestion[];
  /** the owner may want to act while the caller is still on the line */
  alert: boolean;
  usage?: TokenUsage;
}

export interface SummaryResult {
  text: string;
  usage?: TokenUsage;
}

export interface AgentResult {
  /** instructions to append to the Live session, if any */
  instructions?: string;
  toolCalls: ToolCallRecord[];
  /** where the next run continues the conversation; only set when the run completed */
  responseId?: string;
  /** every response of the run, summed */
  usage?: TokenUsage;
}

export interface Agent {
  run(input: AgentInput): Promise<AgentResult>;
  /** End-of-call summary; with previousResponseId it also sees the agent's guidance and tool calls. */
  summarize(
    meta: CallMeta,
    transcript: readonly TranscriptEntry[],
    opts?: { previousResponseId?: string; ownerMessages?: readonly string[] },
  ): Promise<SummaryResult>;
  /** Rolling summary for the owner's status message (luna.yaml progress); agents without it have none. */
  progress?(
    meta: CallMeta,
    transcript: readonly TranscriptEntry[],
    opts?: {
      ownerMessages?: readonly string[];
      /** the owner's buttons from the previous update, kept unless they no longer fit */
      suggestions?: readonly Suggestion[];
      signal?: AbortSignal;
    },
  ): Promise<Progress>;
}

export interface CallRecord {
  id: string;
  callControlId: string;
  from: string;
  to: string;
  divertedFrom: string | null;
  /** public page calls: the visitor's IP */
  callerIp: string | null;
  status: CallStatus;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  verdict: string | null;
  /** the last call-flow stage */
  stage: string | null;
  lunaCalls: number;
  costUsd: number | null;
  /** costUsd by vendor; null on calls from before costs were recorded (costUsd is an estimate) */
  costs: CallCosts | null;
  summary: string | null;
  recordingPath: string | null;
}

export interface StoredEvent {
  id: number;
  callId: string;
  at: number;
  event: CallEvent;
}

export interface Repo {
  createCall(rec: Pick<CallRecord, "id" | "callControlId" | "from" | "to" | "divertedFrom" | "startedAt"> & { callerIp?: string | null }): Promise<void>;
  updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>): Promise<void>;
  getCall(id: string): Promise<CallRecord | null>;
  findByCallControlId(callControlId: string): Promise<CallRecord | null>;
  listCalls(limit: number): Promise<CallRecord[]>;
  /** calls not yet ended */
  listOpenCalls(): Promise<CallRecord[]>;
  /** calls from `from` that started at or after `since` */
  listCallsFrom(from: string, since: number): Promise<CallRecord[]>;
  /** stores the event and, in the same transaction, applies `patch` to its call row */
  appendEvent(ev: CallEvent, patch?: Partial<Omit<CallRecord, "id">>): Promise<void>;
  listEvents(callId: string): Promise<StoredEvent[]>;
}

export interface BlobStore {
  put(key: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<{ body: ReadableStream | Blob; contentType: string } | null>;
}

/** How a message to the owner looks, beyond its plain text. */
export interface MessageLayout {
  /** ranges of the text shown collapsed, tap to expand (Telegram: expandable_blockquote) */
  collapsed?: { offset: number; length: number }[];
  /** buttons under the message, in rows; pressing one comes back as an OwnerButtonPress */
  buttons?: { label: string; data: string }[][];
}

/** The owner's chat (Telegram): the recipient is fixed by the adapter. */
export interface OwnerChat {
  /** sends a message (plain text) and returns its id */
  send(text: string, opts?: { replyTo?: number; silent?: boolean; layout?: MessageLayout }): Promise<number>;
  /** replaces a message's text and layout (buttons left out are removed) */
  edit(messageId: number, text: string, layout?: MessageLayout): Promise<void>;
  /** acknowledges a button press, with a short notice shown to the owner */
  answerButton(pressId: string, notice?: string): Promise<void>;
}

/** The owner pressed a button under one of our messages. */
export interface OwnerButtonPress {
  pressId: string;
  /** the message the button is on */
  messageId: number;
  data: string;
}

/** A message from the owner's chat. */
export interface OwnerMessage {
  messageId: number;
  /** absent for anything but text (a photo, a voice note…) */
  text?: string;
  /** the message it replies to */
  replyTo?: number;
  /** when it was sent (epoch ms) */
  date: number;
}

export interface EventBus {
  publish(ev: CallEvent): void;
  subscribe(fn: (ev: CallEvent) => void): () => void;
}

export interface Clock {
  now(): number;
}
