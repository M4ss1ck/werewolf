// Who drives a seat. Human seats carry no controller; a bot seat carries the
// settings of the roster entry it was seated from, resolved at seating time so
// the match is reproducible even if the roster file changes later.
//
// Secrets never appear here. The base URL and API key come from the server
// environment and are never stored on a game row, never projected to a viewer
// and never sent to a model.

import { z } from "zod";

export const BotConfigSchema = z.object({
  /** The roster entry this seat came from. */
  botId: z.string().min(1),
  provider: z.string().min(1),
  /** Null means this bot has no model: it plays random legal actions. */
  model: z.string().min(1).nullable(),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  /** One short line of flavour, injected verbatim into the prompt. */
  personality: z.string().max(200).optional(),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;

export const PlayerControllerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("human") }),
  z.object({ type: z.literal("bot"), config: BotConfigSchema }),
]);
export type PlayerController = z.infer<typeof PlayerControllerSchema>;

/** Why a roster entry cannot be seated right now. Stable wire values; the
 * client renders them in the viewer's language. */
export const BOT_UNAVAILABLE_REASONS = [
  "PROVIDER_NOT_CONFIGURED",
  "MODEL_NOT_AVAILABLE",
  "ALREADY_SEATED",
] as const;
export type BotUnavailableReason = (typeof BOT_UNAVAILABLE_REASONS)[number];
export const BotUnavailableReasonSchema = z.enum(BOT_UNAVAILABLE_REASONS);

/** One selectable bot, as the lobby sees it. Carries no credentials and no
 * endpoint — only the identity and which model would be thinking for it. */
export const BotRosterEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  model: z.string().nullable(),
  personality: z.string().optional(),
  available: z.boolean(),
  reason: BotUnavailableReasonSchema.optional(),
});
export type BotRosterEntry = z.infer<typeof BotRosterEntrySchema>;

/** Body of `POST /api/games/:id/bots`: seat this roster entry. */
export const AddBotRequestSchema = z.object({
  botId: z.string().min(1),
});
export type AddBotRequest = z.infer<typeof AddBotRequestSchema>;
