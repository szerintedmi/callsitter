import { describe, expect, test } from "bun:test";
import { TelegramNotifier } from "../src/adapters/telegram/bot";

const TOKEN = "123456:ABC-secret";

function notifier(respond: () => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const n = new TelegramNotifier({
    botToken: TOKEN,
    chatId: "42",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return respond();
    }) as unknown as typeof fetch,
  });
  return { n, calls };
}

describe("Telegram notifier", () => {
  test("sends plain text to the owner's chat", async () => {
    const { n, calls } = notifier(() => Response.json({ ok: true, result: {} }));
    await n.send("Sarah called");
    expect(calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        body: { chat_id: "42", text: "Sarah called", link_preview_options: { is_disabled: true } },
      },
    ]);
  });

  test("errors carry Telegram's description but never the token", async () => {
    const { n } = notifier(() => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }));
    await expect(n.send("x")).rejects.toThrow("Telegram sendMessage failed: 403 Forbidden: bot was blocked by the user");

    const down = new TelegramNotifier({
      botToken: TOKEN,
      chatId: "42",
      fetch: (async (url: string) => {
        throw new Error(`Unable to connect: ${url}`);
      }) as unknown as typeof fetch,
    });
    const err = await down.send("x").catch((e: Error) => e);
    expect(String(err)).toContain("Unable to connect");
    expect(String(err)).not.toContain(TOKEN);
  });
});
