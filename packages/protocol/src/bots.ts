// Who drives a seat. Human seats carry no controller at all; a bot seat carries
// a serializable config naming the provider and model that decide for it.
//
// Secrets never appear here. The base URL and API key come from the server
// environment and are never stored on a game row, never projected to a viewer
// and never sent to a model.

import { z } from "zod";

export const BotConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  /** One short line of flavour, injected verbatim into the prompt. */
  personality: z.string().max(200).optional(),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;

export const PlayerControllerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("human") }),
  z.object({ type: z.literal("bot"), config: BotConfigSchema }),
]);
export type PlayerController = z.infer<typeof PlayerControllerSchema>;

/** Body of `POST /api/games/:id/bots`. Every field is optional: the server
 * fills the name from its pool and the config from its environment, so the
 * host can add a usable bot with an empty body. */
export const AddBotRequestSchema = z.object({
  displayName: z.string().min(1).max(24).optional(),
  count: z.number().int().min(1).max(12).optional(),
  config: BotConfigSchema.partial().optional(),
});
export type AddBotRequest = z.infer<typeof AddBotRequestSchema>;
