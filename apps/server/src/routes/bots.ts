import { AddBotRequestSchema, type GameId, type UserId } from "@werewolf/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import type { BotRuntimeConfig } from "../bots/config.ts";
import type { ModelCatalog } from "../bots/model-catalog.ts";
import { type BotRosterDefinition, describeRoster, toSeatConfig } from "../bots/roster.ts";
import { CoordinatorError, type GameCoordinator } from "../game/coordinator.ts";

export interface BotRoutesOptions {
  roster: readonly BotRosterDefinition[];
  catalog: ModelCatalog;
  config: BotRuntimeConfig;
}

/** Host-only lobby controls for seating bots. Mounted only when the server was
 * built with bot support, so a deployment without it simply has no endpoint. */
export function botRoutes(coordinator: GameCoordinator, options: BotRoutesOptions) {
  const app = new Hono();
  const viewerOf = (c: Context) => c.get("viewer") as ViewerContext;

  async function requireOwner(gameId: GameId, userId: UserId) {
    await coordinator.authorizeGameAccess(gameId, userId, "mutation");
    const game = await coordinator.getGame(gameId);
    if (!game) throw new CoordinatorError("GAME_NOT_FOUND");
    if (game.ownerUserId !== userId) throw new CoordinatorError("NOT_GAME_OWNER");
    return game;
  }

  function failure(error: unknown) {
    const code = error instanceof CoordinatorError ? error.code : "VALIDATION";
    const status =
      code === "GAME_NOT_FOUND"
        ? 404
        : code === "NOT_GAME_OWNER" || code === "ACTION_NOT_AVAILABLE"
          ? 403
          : code === "GAME_ALREADY_STARTED"
            ? 409
            : 400;
    return { body: { error: { code } }, status } as const;
  }

  // The roster the host may choose from, with per-entry availability. Carries
  // no key and no endpoint, only which model would be thinking for each bot.
  app.get("/games/:id/bots", async (c) => {
    const gameId = c.req.param("id") as GameId;
    try {
      await requireOwner(gameId, viewerOf(c).userId as UserId);
      const seated = await coordinator.seatedBotIds(gameId);
      return c.json(describeRoster(options.roster, options.catalog, seated));
    } catch (error) {
      const { body, status } = failure(error);
      return c.json(body, status);
    }
  });

  app.post("/games/:id/bots", async (c) => {
    const parsed = AddBotRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    const gameId = c.req.param("id") as GameId;
    const entry = options.roster.find((candidate) => candidate.id === parsed.data.botId);
    if (!entry) return c.json({ error: { code: "ACTION_NOT_AVAILABLE" } }, 404);
    try {
      const userId = viewerOf(c).userId as UserId;
      await requireOwner(gameId, userId);
      // Availability is rechecked here, not trusted from whatever the client
      // last rendered: a model that vanished, or a provider that was never
      // configured, must not become a seat that can never think.
      const seated = await coordinator.seatedBotIds(gameId);
      const view = describeRoster([entry], options.catalog, seated)[0]!;
      if (!view.available) throw new CoordinatorError("ACTION_NOT_AVAILABLE");
      return c.json(
        await coordinator.addBot(gameId, userId, {
          displayName: entry.displayName,
          config: toSeatConfig(entry, options.config.BOT_AI_PROVIDER),
        }),
      );
    } catch (error) {
      const { body, status } = failure(error);
      return c.json(body, status);
    }
  });

  return app;
}
