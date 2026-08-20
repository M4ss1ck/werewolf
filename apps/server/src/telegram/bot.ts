import { Bot, InputFile } from "grammy";

export type TelegramBotOptions = {
  token: string;
  /** Public app origin; the /start WebApp button points here. */
  webAppUrl: string;
  /** Absolute path to the app icon, or null when no client build exists. */
  logoPath: string | null;
};

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Open the game" },
  { command: "help", description: "List the available commands" },
  { command: "ping", description: "Check the bot's latency" },
] as const;

const WELCOME_CAPTION = "Welcome to Werewolf, the live social-deduction game. Tap below to play.";

// A web_app button is only valid in a private chat; Telegram rejects it
// elsewhere with BUTTON_TYPE_INVALID, and a bot added to a group is a reachable
// state. Fall back to a plain URL button so the command still works there.
function playButton(webAppUrl: string, chatType: string) {
  if (chatType === "private") {
    return { text: "Play Werewolf", web_app: { url: webAppUrl } };
  }
  return { text: "Play Werewolf", url: webAppUrl };
}

export function createTelegramBot(options: TelegramBotOptions): Bot {
  const bot = new Bot(options.token);

  // Telegram keeps an uploaded photo and hands back a file_id; sending that
  // string later serves its stored copy with no upload. Re-uploading the same
  // image on every /start is pure waste, and since grammY processes updates
  // sequentially it would also make concurrent /start commands queue.
  let logoFileId: string | undefined;

  bot.command("start", async (ctx) => {
    const replyMarkup = {
      inline_keyboard: [[playButton(options.webAppUrl, ctx.chat.type)]],
    };
    if (options.logoPath) {
      const sent = await ctx.replyWithPhoto(logoFileId ?? new InputFile(options.logoPath), {
        caption: WELCOME_CAPTION,
        reply_markup: replyMarkup,
      });
      if (!logoFileId && sent.photo.length > 0) {
        logoFileId = sent.photo[sent.photo.length - 1]!.file_id;
      }
    } else {
      await ctx.reply(WELCOME_CAPTION, { reply_markup: replyMarkup });
    }
  });

  bot.command("help", async (ctx) => {
    const lines = TELEGRAM_COMMANDS.map((entry) => `/${entry.command} — ${entry.description}`);
    await ctx.reply(lines.join("\n"));
  });

  bot.command("ping", async (ctx) => {
    const started = Date.now();
    const sent = await ctx.reply("Pinging…");
    const elapsed = Date.now() - started;
    await ctx.api.editMessageText(ctx.chat.id, sent.message_id, `Pong! ${elapsed}ms`);
  });

  // A handler error must never crash the process; log it and keep polling.
  bot.catch((error) => {
    console.error("telegram bot handler error:", error.error);
  });

  return bot;
}

// Registers the commands programmatically (no BotFather setup) and starts long
// polling. bot.start() only resolves when the bot stops, so it is not awaited.
export async function startTelegramBot(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
  void bot.start({
    onStart: (botInfo) => console.log(`telegram bot @${botInfo.username} started`),
  });
}
