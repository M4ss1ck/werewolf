// Bot runtime configuration, read from the environment like everything else
// the server needs. The key and base URL stay here: they are never written to
// a game row, never projected to a viewer and never sent to a model.
//
// With no `BOT_AI_API_KEY` the server still runs bots — they fall back to
// picking a random legal action — so an unattended engine-exercising match
// needs no account and costs nothing.

import type { BotConfig } from "@werewolf/protocol";
import { z } from "zod";

const botEnvSchema = z.object({
  BOT_AI_BASE_URL: z.string().url().default("https://api.deepseek.com/v1"),
  BOT_AI_API_KEY: z.string().optional(),
  BOT_AI_MODEL: z.string().min(1).default("deepseek-chat"),
  BOT_AI_PROVIDER: z.string().min(1).default("openai-compatible"),
  BOT_AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),
  BOT_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(180),
  BOT_AI_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Artificial pause before a bot publishes, so it does not answer instantly.
   * Set both to 0 in automated tests to run matches as fast as possible. */
  BOT_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(1_500),
  BOT_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(6_000),
  /** How many times one bot may speak in a single discussion phase. This is
   * the hard cap on model calls: bots x turns per discussion. */
  BOT_DISCUSSION_TURNS: z.coerce.number().int().min(1).max(6).default(2),
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

type BotConfigOverrides = { [K in keyof BotConfig]?: BotConfig[K] | undefined };

/** The per-seat config stored on a bot player row, from the server defaults
 * plus whatever the host overrode. Credentials are deliberately not included. */
export function resolveSeatConfig(
  runtime: BotRuntimeConfig,
  overrides: BotConfigOverrides = {},
): BotConfig {
  return {
    provider: overrides.provider ?? runtime.BOT_AI_PROVIDER,
    model: overrides.model ?? runtime.BOT_AI_MODEL,
    temperature: overrides.temperature ?? runtime.BOT_AI_TEMPERATURE,
    ...(overrides.personality ? { personality: overrides.personality } : {}),
  };
}
