import { logger } from "../../core/log";
import { errMsg } from "../../core/orchestrator";
import type { MessageLayout, OwnerButtonPress, OwnerChat, OwnerMessage } from "../../core/ports";

// Telegram Bot API (https://core.telegram.org/bots/api): an instance talks to one chat (the
// owner's, or the group for public-page calls); one bot can be in several chats, each with its own
// instance on the same token. The owner has to start a chat with the bot first. Messages are plain text (no parse_mode), so
// Luna's text and transcripts need no escaping. Incoming messages arrive by long polling
// (getUpdates), which needs no public URL; it fails while a webhook is set, and only one poller
// per bot works at a time, so dev and production need separate bots. Collapsed parts of a message
// are expandable_blockquote entities (offsets in UTF-16 code units, as JS strings count), and
// buttons are an inline keyboard whose presses arrive as callback queries.

const log = logger("telegram");

export interface TelegramOptions {
  /** from @BotFather */
  botToken: string;
  /** the owner's chat with the bot (numeric id), or a channel's @username */
  chatId: string;
  fetch?: typeof fetch;
}

/** Where `listen` hands a chat's messages and button presses. */
export interface ChatRoute {
  /** numeric chat id, as in TelegramOptions.chatId */
  chatId: string;
  message: (m: OwnerMessage) => void | Promise<void>;
  button: (b: OwnerButtonPress) => void | Promise<void>;
}

/** getUpdates long-poll timeout (s) */
const POLL_TIMEOUT_S = 50;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60_000;

/** MessageLayout as sendMessage/editMessageText parameters. */
function layoutParams(layout: MessageLayout | undefined, edit: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (layout?.collapsed?.length) out.entities = layout.collapsed.map((q) => ({ type: "expandable_blockquote", offset: q.offset, length: q.length }));
  const rows = layout?.buttons?.filter((r) => r.length) ?? [];
  // An edit without buttons removes the ones the message had.
  if (rows.length || edit) out.reply_markup = { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.label, callback_data: b.data }))) };
  return out;
}

interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
}

interface TgCallbackQuery {
  id: string;
  /** the message with the button; absent for inline-mode messages */
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export class TelegramBot implements OwnerChat {
  private f: typeof fetch;

  constructor(private o: TelegramOptions) {
    this.f = o.fetch ?? fetch;
  }

  /** Only a numeric chat can be heard from: a channel's @username can't message the bot. */
  get canListen(): boolean {
    return /^-?[0-9]+$/.test(this.o.chatId);
  }

  // The token is part of the URL: keep it out of error messages, which reach logs and Luna.
  private redact(s: string) {
    return s.replaceAll(this.o.botToken, "<token>");
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`https://api.telegram.org/bot${this.o.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new Error(`Telegram ${method} failed: ${this.redact(errMsg(err))}`);
    }
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: T };
    if (!res.ok || !out.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${this.redact(out.description ?? "")}`.trim());
    return out.result as T;
  }

  async send(text: string, opts: { replyTo?: number; silent?: boolean; layout?: MessageLayout } = {}): Promise<number> {
    const msg = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.o.chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...layoutParams(opts.layout, false),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.replyTo !== undefined ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
    });
    return msg.message_id;
  }

  async edit(messageId: number, text: string, layout?: MessageLayout): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: this.o.chatId,
        message_id: messageId,
        text,
        link_preview_options: { is_disabled: true },
        ...layoutParams(layout, true),
      });
    } catch (err) {
      // The same text again: nothing to do.
      if (err instanceof Error && err.message.includes("message is not modified")) return;
      throw err;
    }
  }

  /** "Telegram clients will display a progress bar until you call answerCallbackQuery." */
  async answerButton(pressId: string, notice?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: pressId, ...(notice ? { text: notice.slice(0, 200) } : {}) });
  }

  /**
   * Long-polls for messages and button presses until `signal` aborts, handing each to the route
   * for its chat; anything from another chat is ignored. One loop per token: Telegram answers a
   * second poller with 409, so every chat the bot serves goes through one call. Failures are
   * logged and retried with backoff.
   */
  async listen(routes: ChatRoute[], signal: AbortSignal): Promise<void> {
    const byChat = new Map(routes.map((r) => [r.chatId, r]));
    let offset: number | undefined;
    let retryMs = RETRY_MIN_MS;
    while (!signal.aborted) {
      let updates: { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }[];
      try {
        updates = await this.call("getUpdates", { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"] }, signal);
        retryMs = RETRY_MIN_MS;
      } catch (err) {
        if (signal.aborted) return;
        log.warn(`polling failed; retrying in ${retryMs / 1000} s`, { err });
        await sleep(retryMs, signal);
        retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          const m = u.message;
          const q = u.callback_query;
          const route = byChat.get(String((m ?? q?.message)?.chat.id));
          if (!route) continue;
          if (m) {
            await route.message({
              messageId: m.message_id,
              date: m.date * 1000,
              ...(m.text !== undefined ? { text: m.text } : {}),
              ...(m.reply_to_message ? { replyTo: m.reply_to_message.message_id } : {}),
            });
          } else if (q?.message && q.data !== undefined) {
            await route.button({ pressId: q.id, messageId: q.message.message_id, data: q.data });
          }
        } catch (err) {
          log.error("handling an update failed", { err });
        }
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}
