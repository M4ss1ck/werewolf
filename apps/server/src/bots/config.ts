// Bot runtime configuration.
//
// The environment holds what is deployment-wide and secret: which provider,
// where it lives, and the key. Everything that varies per bot — model,
// temperature, output ceiling, timeout, personality — lives in the roster file
// instead, so one deployment can run a cheap model for most seats and a slower
// one for a couple of them.
//
// The key stays here: it is never written to a game row, never sent to a
// client, and never logged.

import { z } from "zod";

const botEnvSchema = z.object({
  BOT_AI_PROVIDER: z.string().min(1).default("opencode-go"),
  BOT_AI_BASE_URL: z.string().url().default("https://opencode.ai/zen/go/v1"),
  BOT_AI_API_KEY: z.string().optional(),

  /** Where the roster of selectable bots is defined. */
  BOT_ROSTER_PATH: z.string().min(1).default("./bots.json"),

  /** Ceiling on model calls in flight across the whole process. Bots are
   * asynchronous and a phase never waits for them, so queueing here costs a
   * bot its turn at worst, and protects the provider from a room full of
   * simultaneous games. */
  BOT_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().max(64).default(4),

  /** Artificial pause before a bot publishes, so it does not answer instantly.
   * Set both to 0 in automated tests to run matches as fast as possible. */
  BOT_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(1_500),
  BOT_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(6_000),

  /** How many turns one bot may take in a single discussion or voting phase,
   * counting the unconditional first one. This is the hard cap on model calls:
   * bots x turns per phase. */
  BOT_CHAT_TURNS: z.coerce.number().int().min(1).max(6).default(2),

  /** How many recent visible events go into a prompt. Bounded on purpose: the
   * match log must not grow into every request. */
  BOT_HISTORY_LIMIT: z.coerce.number().int().positive().default(24),

  /** Development aid. Never enable in production: prompts carry the bot's own
   * hidden role. */
  BOT_LOG_PROMPTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type BotRuntimeConfig = z.infer<typeof botEnvSchema>;

export function loadBotConfig(
  source: Record<string, string | undefined> = process.env,
): BotRuntimeConfig {
  const parsed = botEnvSchema.safeParse(source);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid bot configuration: ${bad}`);
  }
  return parsed.data;
}
