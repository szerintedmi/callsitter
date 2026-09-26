import type { AudioFormat } from "./audio";
import type { AppConfig, JevConfig, LiveAppend, LunaTool } from "./config";
import type { CallEvent, CallMeta, CallStatus, Classification, Speaker, ToolCallRecord, TranscriptEntry } from "./types";

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
}

export interface Classifier {
  classify(input: ClassifierInput): Promise<Classification>;
}

/** Tools that Luna can call; implemented by the orchestrator per call. */
export interface ToolContext {
  sendTelegramToOwner(text: string): Promise<string>;
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
}

export interface AgentResult {
  /** instructions to append to the Live session, if any */
  instructions?: string;
  toolCalls: ToolCallRecord[];
  /** where the next run continues the conversation; only set when the run completed */
  responseId?: string;
}

export interface Agent {
  run(input: AgentInput): Promise<AgentResult>;
  /** End-of-call summary; with previousResponseId it also sees the agent's guidance and tool calls. */
  summarize(meta: CallMeta, transcript: readonly TranscriptEntry[], opts?: { previousResponseId?: string }): Promise<string>;
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

/** Sends a message to the phone's owner (the recipient is fixed by the adapter). */
export interface Notifier {
  send(text: string): Promise<void>;
}

export interface EventBus {
  publish(ev: CallEvent): void;
  subscribe(fn: (ev: CallEvent) => void): () => void;
}

export interface Clock {
  now(): number;
}
