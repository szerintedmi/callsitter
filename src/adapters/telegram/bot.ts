import type { Notifier } from "../../core/ports";

// Telegram Bot API sendMessage (https://core.telegram.org/bots/api#sendmessage): the bot
// messages one chat, the owner's. The owner has to start a chat with the bot first.

export interface TelegramOptions {
  /** from @BotFather */
  botToken: string;
  /** the owner's chat with the bot (numeric id), or a channel's @username */
  chatId: string;
  fetch?: typeof fetch;
}

export class TelegramNotifier implements Notifier {
  private f: typeof fetch;

  constructor(private o: TelegramOptions) {
    this.f = o.fetch ?? fetch;
  }

  async send(text: string) {
    // The token is part of the URL: keep it out of error messages, which reach logs and Luna.
    const redact = (s: string) => s.replaceAll(this.o.botToken, "<token>");
    let res: Response;
    try {
      res = await this.f(`https://api.telegram.org/bot${this.o.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Plain text (no parse_mode), so Luna's text needs no escaping.
        body: JSON.stringify({ chat_id: this.o.chatId, text, link_preview_options: { is_disabled: true } }),
      });
    } catch (err) {
      throw new Error(`Telegram sendMessage failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !body.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${redact(body.description ?? "")}`.trim());
  }
}
