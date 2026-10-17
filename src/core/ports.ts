import type { AnalyticsSummary, PageEventRecord, VisitSummary } from "./analytics";
import type { AudioFormat } from "./audio";
import type { AppConfig, GamesConfig, JevConfig, LiveAppend, LunaTool } from "./config";
import type { BoardEntry, Game } from "./game";
import type { Channel, LimitHit } from "./limits";
import type { CallCosts, CallEvent, CallMeta, CallStatus, EndedBy, Classification, Speaker, Suggestion, TokenUsage, ToolCallRecord, TranscriptEntry, Verdict } from "./types";

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
  /** the session is gone: `reason` is why, when the vendor ended it (absent: the connection dropped) */
  onClose(reason?: string): void;
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
  /** resolves once the session has shut down (and handed over anything it recorded, unless keepRecording took it) */
  close(): Promise<void>;
  /**
   * OpenAI SIP: transfers the call (a SIP REFER) to `targetUri`; resolves once the vendor has
   * accepted it, rejects once `signal` aborts. The session ends once the carrier has followed it.
   */
  refer?(targetUri: string, signal: AbortSignal): Promise<void>;
  /**
   * The session's own recording (OpenAI SIP) goes on past close(), for the rest of the call
   * after a takeover, up to `maxSeconds` from the call's start; null if it records nothing.
   * close() no longer hands it over: finish() does.
   */
  keepRecording?(maxSeconds: number): CallRecording | null;
}

/** A recording that outlives its voice session (keepRecording): the takeover's part of the call. */
export interface CallRecording {
  /** caller audio as it arrives: mono PCM16 at `rate` Hz */
  caller(pcm16: Int16Array, rate: number): void;
  /** the owner's audio as it arrives (on the agent's track): mono PCM16 at `rate` Hz */
  owner(pcm16: Int16Array, rate: number): void;
  /** hands the recording over (once) */
  finish(): void;
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

export interface RefereeInput {
  game: Game;
  goal: GamesConfig["scam"]["goals"][number] | GamesConfig["get_through"]["goals"][number];
  transcript: readonly TranscriptEntry[];
  config: GamesConfig["referee"];
  signal?: AbortSignal;
}

/** Judges a public game call (src/core/referee.ts): has the caller met their goal? */
export interface Referee {
  /** each of the game's questions (games.yaml referee) → the probability of "yes" */
  judge(input: RefereeInput): Promise<Record<string, number>>;
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
    opts?: {
      previousResponseId?: string;
      ownerMessages?: readonly string[];
      stage?: string | null;
      /** the owner took the call over this long into it (ms): the transcript ends there */
      takenOverAt?: number;
    },
  ): Promise<SummaryResult>;
  /** Rolling summary for the owner's status message (luna.yaml progress); agents without it have none. */
  progress?(
    meta: CallMeta,
    transcript: readonly TranscriptEntry[],
    opts?: {
      ownerMessages?: readonly string[];
      /** the owner's buttons from the previous update, kept unless they no longer fit */
      suggestions?: readonly Suggestion[];
      /** the call-flow stage: how the agent was told to handle the call (null: not told yet) */
      stage?: string | null;
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
  channel: Channel;
  /** the limit (limits.yaml) it was turned away for, unanswered; null: admitted */
  declined: LimitHit | null;
  /** public page calls: the visitor's IP */
  callerIp: string | null;
  status: CallStatus;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  /** null on calls from before it was recorded */
  endedBy: EndedBy | null;
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

/** A public page game: who played which goal on a call, and their score once it has ended. */
export interface PlayRecord {
  callId: string;
  game: Game;
  goal: string;
  /** 1–3 letters or digits */
  player: string;
  /** ms (scam: until caught; get_through: until reached); null if they didn't make it */
  scoreMs: number | null;
  createdAt: number;
  /** when the call ended and the score was settled */
  finishedAt: number | null;
}

export interface StoredEvent {
  id: number;
  callId: string;
  at: number;
  event: CallEvent;
}

/** The admin call list's filters; a missing field matches every call. */
export interface CallFilter {
  channel?: Channel;
  verdict?: Verdict;
}

export interface Repo {
  createCall(
    rec: Pick<CallRecord, "id" | "callControlId" | "from" | "to" | "divertedFrom" | "channel" | "startedAt"> & { callerIp?: string | null; declined?: LimitHit | null },
  ): Promise<void>;
  updateCall(id: string, patch: Partial<Omit<CallRecord, "id">>): Promise<void>;
  getCall(id: string): Promise<CallRecord | null>;
  findByCallControlId(callControlId: string): Promise<CallRecord | null>;
  /** newest first */
  listCalls(limit: number, filter?: CallFilter): Promise<CallRecord[]>;
  /** calls not yet ended */
  listOpenCalls(): Promise<CallRecord[]>;
  /** calls on `channel` that started or ended at or after `since` */
  listCallsByChannel(channel: Channel, since: number): Promise<CallRecord[]>;
  /** stores the event and, in the same transaction, applies `patch` to its call row */
  appendEvent(ev: CallEvent, patch?: Partial<Omit<CallRecord, "id">>): Promise<void>;
  listEvents(callId: string): Promise<StoredEvent[]>;
  /** stores a game as its call starts (the call row must exist) */
  createPlay(p: Pick<PlayRecord, "callId" | "game" | "goal" | "player" | "createdAt">): Promise<void>;
  /** settles the game's score once its call has ended */
  finishPlay(callId: string, scoreMs: number | null, finishedAt: number): Promise<void>;
  getPlay(callId: string): Promise<PlayRecord | null>;
  /** every score on a goal (a player can have several), best first */
  scores(game: Game, goal: string): Promise<BoardEntry[]>;
  /** total seconds of ended calls whose verdict is scam or spam, and of every "Scam me" game */
  junkCallSeconds(): Promise<number>;
  /** stores a "notify me" or waitlist sign-up; an email already on that list gets the new details and is pending (not notified) again */
  addNotifySignup(s: NotifySignup): Promise<void>;
  /** the public site's page analytics (src/core/analytics.ts) */
  addPageEvents(rows: PageEventRecord[]): Promise<void>;
  /** the dashboard's numbers over events at or after `since` */
  pageStats(since: number, demos: readonly string[]): Promise<AnalyticsSummary>;
  /** visits seen at or after `since`, newest first */
  pageVisits(since: number, limit: number): Promise<VisitSummary[]>;
  /** a visit's events, oldest first */
  pageVisit(visitId: string): Promise<PageEventRecord[]>;
  /** deletes page events from before `before`; how many */
  prunePageEvents(before: number): Promise<number>;
}

/** A public page visitor who left their email: to hear when there's game again (POST call/notify), or on the waitlist for their own bot (POST call/waitlist). */
export interface NotifySignup {
  email: string;
  list: "notify" | "waitlist";
  createdAt: number;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  /** notify: what had run out then; null: nothing, and always on the waitlist */
  reason: "closed" | "quota" | "budget" | null;
}

export interface BlobStore {
  put(key: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<{ body: ReadableStream | Blob; contentType: string } | null>;
}

/** How a message to the owner looks, beyond its plain text. */
export interface MessageLayout {
  /** ranges of the text shown collapsed, tap to expand (Telegram: expandable_blockquote) */
  collapsed?: { offset: number; length: number }[];
  /**
   * buttons under the message, in rows; pressing one comes back as an OwnerButtonPress. One
   * with `webApp` opens that https URL as a Telegram Mini App instead (private chats only).
   */
  buttons?: ({ label: string; data: string; webApp?: undefined } | { label: string; webApp: string; data?: undefined })[][];
}

/** The page the owner took a call over from (takeover): plays the caller and hears the owner. */
export interface OwnerAudioLeg {
  /** caller audio for the owner: 16 kHz mono PCM16 */
  sendAudio(pcm16: Int16Array): void;
  /** how the takeover is going, for the page */
  notify(state: TakeoverState): void;
  /** closes the page's connection (after the call ended) */
  close(): void;
}

export type TakeoverState =
  | { type: "connecting" }
  | { type: "live" }
  | { type: "ended"; reason: string }
  | { type: "error"; message: string };

/** What the takeover page measures itself (src/web/client/takeover.ts), counted since it loaded. */
export interface OwnerPageStats {
  /** mic frames sent to the server */
  sentFrames: number;
  /** times the caller's playback ran dry mid-word (audio arrived late) */
  underruns: number;
  /** time the owner was muted (the mic then sends silence) */
  mutedMs: number;
}

/** What the page's connection gets back from CallManager.takeOver. */
export interface TakeoverHandle {
  /** the owner's mic: 16 kHz mono PCM16 */
  ownerAudio(pcm16: Int16Array): void;
  /** the page's connection dropped: the call hangs up unless the owner is back within takeover.reconnect_grace_ms */
  ownerLeft(): void;
  /** the owner hung up on the page: the call ends, at the carrier too */
  hangUp(): void;
  /** the page's own audio counters (cumulative since it loaded), for the takeover's stats line */
  pageStats(s: OwnerPageStats): void;
  /**
   * What this page presents to reconnect (CallManager.resumeTakeover) instead of Telegram's
   * initData, which goes stale (init_data_max_age_s) long before a takeover ends. Valid until
   * the next connection replaces this one or the call ends.
   */
  reconnectToken: string;
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
