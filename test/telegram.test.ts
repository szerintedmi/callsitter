import { describe, expect, test } from "bun:test";
import { TelegramBot } from "../src/adapters/telegram/bot";
import type { OwnerButtonPress, OwnerMessage } from "../src/core/ports";

const TOKEN = "123456:ABC-secret";

function bot(respond: (method: string, body: Record<string, unknown>) => Response | Promise<Response>, chatId = "42") {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const b = new TelegramBot({
    botToken: TOKEN,
    chatId,
    fetch: (async (url: string, init: RequestInit) => {
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(String(init.body));
      calls.push({ method, body });
      return respond(method, body);
    }) as unknown as typeof fetch,
  });
  return { b, calls };
}

describe("Telegram bot", () => {
  test("sends plain text to the owner's chat and returns the message id", async () => {
    const { b, calls } = bot(() => Response.json({ ok: true, result: { message_id: 7 } }));
    expect(await b.send("Sarah called")).toBe(7);
    expect(await b.send("urgent", { replyTo: 7, silent: true })).toBe(7);
    expect(calls).toEqual([
      { method: "sendMessage", body: { chat_id: "42", text: "Sarah called", link_preview_options: { is_disabled: true } } },
      {
        method: "sendMessage",
        body: {
          chat_id: "42",
          text: "urgent",
          link_preview_options: { is_disabled: true },
          disable_notification: true,
          reply_parameters: { message_id: 7, allow_sending_without_reply: true },
        },
      },
    ]);
  });

  test("collapsed parts are expandable quotes; buttons an inline keyboard, removed by an edit without them", async () => {
    const { b, calls } = bot(() => Response.json({ ok: true, result: { message_id: 7 } }));
    await b.send("hi\nquote", { layout: { collapsed: [{ offset: 3, length: 5 }], buttons: [[{ label: "Genuine", data: "steer:0" }]] } });
    await b.edit(7, "hi");
    await b.answerButton("q1", "Sent: It's a genuine call.");
    expect(calls[0]!.body).toMatchObject({
      entities: [{ type: "expandable_blockquote", offset: 3, length: 5 }],
      reply_markup: { inline_keyboard: [[{ text: "Genuine", callback_data: "steer:0" }]] },
    });
    expect(calls[1]!.body).toMatchObject({ reply_markup: { inline_keyboard: [] } });
    expect(calls[1]!.body.entities).toBeUndefined();
    expect(calls[2]).toEqual({ method: "answerCallbackQuery", body: { callback_query_id: "q1", text: "Sent: It's a genuine call." } });
  });

  test("edits a message; the same text again is not an error", async () => {
    const { b, calls } = bot(() =>
      Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" }, { status: 400 }),
    );
    await b.edit(7, "same");
    expect(calls[0]).toEqual({
      method: "editMessageText",
      body: { chat_id: "42", message_id: 7, text: "same", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } },
    });
  });

  test("errors carry Telegram's description but never the token", async () => {
    const { b } = bot(() => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }));
    await expect(b.send("x")).rejects.toThrow("Telegram sendMessage failed: 403 Forbidden: bot was blocked by the user");

    const down = new TelegramBot({
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

  test("long-polls for the owner's messages only, moving the offset on", async () => {
    const ac = new AbortController();
    const got: OwnerMessage[] = [];
    let polls = 0;
    const { b, calls } = bot((method) => {
      if (method !== "getUpdates") throw new Error(method);
      if (++polls > 1) {
        ac.abort();
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({
        ok: true,
        result: [
          { update_id: 10, message: { message_id: 1, date: 1000, chat: { id: 42 }, text: "keep them talking", reply_to_message: { message_id: 7 } } },
          { update_id: 11, message: { message_id: 2, date: 1001, chat: { id: 99 }, text: "a stranger" } },
          { update_id: 12, message: { message_id: 3, date: 1002, chat: { id: 42 } } },
          { update_id: 13, callback_query: { id: "q1", data: "steer:0", message: { message_id: 7, chat: { id: 42 } } } },
          { update_id: 14, callback_query: { id: "q2", data: "steer:0", message: { message_id: 8, chat: { id: 99 } } } },
        ],
      });
    });
    const presses: OwnerButtonPress[] = [];
    await b.listen({ message: (m) => void got.push(m), button: (p) => void presses.push(p) }, ac.signal);
    expect(got).toEqual([
      { messageId: 1, date: 1_000_000, text: "keep them talking", replyTo: 7 },
      { messageId: 3, date: 1_002_000 },
    ]);
    expect(presses).toEqual([{ pressId: "q1", messageId: 7, data: "steer:0" }]);
    expect(calls[0]!.body).toEqual({ timeout: 50, allowed_updates: ["message", "callback_query"] });
    expect(calls[1]!.body.offset).toBe(15);
  });

  test("only a numeric chat can be heard from", () => {
    expect(bot(() => new Response(), "42").b.canListen).toBe(true);
    expect(bot(() => new Response(), "-1001").b.canListen).toBe(true);
    expect(bot(() => new Response(), "@mychannel").b.canListen).toBe(false);
  });
});
