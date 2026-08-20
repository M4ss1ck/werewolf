import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";
import { createTelegramBot, TELEGRAM_COMMANDS } from "./bot.ts";

const WEB_APP_URL = "https://werewolf.example.com";

type Call = { method: string; payload: Record<string, unknown> };

// Drives the real bot through grammY's testing seam: an API transformer that
// captures every outgoing call and returns canned results, so no network is
// touched. getMe must return a plausible bot User and the send methods a
// Message with a message_id, because /ping edits that same message.
function makeBot(logoPath: string | null) {
  const calls: Call[] = [];
  const bot = createTelegramBot({ token: "test-token", webAppUrl: WEB_APP_URL, logoPath });

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "getMe"
        ? { id: 1, is_bot: true, first_name: "Werewolf", username: "werewolf_bot" }
        : {
            message_id: 42,
            date: 0,
            chat: { id: 1, type: "private" },
            photo: [{ file_id: "cached-file-id", width: 512, height: 512 }],
          };
    return Promise.resolve({ ok: true, result } as never);
  });

  return { bot, calls };
}

function update(chatType: string, text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: { id: 1, is_bot: false, first_name: "Test" },
      chat:
        chatType === "private"
          ? { id: 1, type: "private", first_name: "Test" }
          : { id: 1, type: "group", title: "Test group" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  };
}

async function handle(bot: Bot, chatType: string, text: string) {
  await bot.init();
  await bot.handleUpdate(update(chatType, text));
}

describe("telegram bot", () => {
  test("TELEGRAM_COMMANDS contains exactly start, help, ping in that order", () => {
    expect(TELEGRAM_COMMANDS.map((entry) => entry.command)).toEqual(["start", "help", "ping"]);
  });

  test("/start in a private chat sends a photo with a web_app button", async () => {
    const { bot, calls } = makeBot("/tmp/icon.png");
    await handle(bot, "private", "/start");

    const sendPhoto = calls.find((call) => call.method === "sendPhoto");
    expect(sendPhoto).toBeDefined();
    const button = (sendPhoto!.payload.reply_markup as { inline_keyboard: unknown[][] })
      .inline_keyboard[0]![0] as { web_app: { url: string } };
    expect(button.web_app.url).toBe(WEB_APP_URL);
  });

  test("/start in a group chat produces a url button and no web_app key", async () => {
    const { bot, calls } = makeBot("/tmp/icon.png");
    await handle(bot, "group", "/start");

    const sendPhoto = calls.find((call) => call.method === "sendPhoto");
    expect(sendPhoto).toBeDefined();
    const button = (sendPhoto!.payload.reply_markup as { inline_keyboard: unknown[][] })
      .inline_keyboard[0]![0] as Record<string, unknown>;
    expect(button.url).toBe(WEB_APP_URL);
    expect(button).not.toHaveProperty("web_app");
  });

  test("/start with no logo falls back to a text reply with the button", async () => {
    const { bot, calls } = makeBot(null);
    await handle(bot, "private", "/start");

    expect(calls.some((call) => call.method === "sendPhoto")).toBe(false);
    const sendMessage = calls.find((call) => call.method === "sendMessage");
    expect(sendMessage).toBeDefined();
    const button = (sendMessage!.payload.reply_markup as { inline_keyboard: unknown[][] })
      .inline_keyboard[0]![0] as { web_app: { url: string } };
    expect(button.web_app.url).toBe(WEB_APP_URL);
  });

  test("/start reuses the cached file_id after the first upload", async () => {
    const { bot, calls } = makeBot("/tmp/icon.png");
    await handle(bot, "private", "/start");
    await handle(bot, "private", "/start");

    const sendPhotos = calls.filter((call) => call.method === "sendPhoto");
    expect(sendPhotos).toHaveLength(2);
    expect(sendPhotos[0]!.payload.photo).toBeInstanceOf(InputFile);
    expect(sendPhotos[1]!.payload.photo).toBe("cached-file-id");
  });

  test("/help mentions all three commands", async () => {
    const { bot, calls } = makeBot("/tmp/icon.png");
    await handle(bot, "private", "/help");

    const sendMessage = calls.find((call) => call.method === "sendMessage");
    const text = sendMessage!.payload.text as string;
    expect(text).toContain("/start");
    expect(text).toContain("/help");
    expect(text).toContain("/ping");
  });

  test("/ping sends a message then edits that same message_id", async () => {
    const { bot, calls } = makeBot("/tmp/icon.png");
    await handle(bot, "private", "/ping");

    const sendMessage = calls.find((call) => call.method === "sendMessage");
    expect(sendMessage).toBeDefined();
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit).toBeDefined();
    expect(edit!.payload.message_id).toBe(42);
    expect(edit!.payload.chat_id).toBe(sendMessage!.payload.chat_id);
  });
});
