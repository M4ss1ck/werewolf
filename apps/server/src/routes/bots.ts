import { AddBotRequestSchema, type GameId, type UserId } from "@werewolf/protocol";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import { type BotRuntimeConfig, resolveSeatConfig } from "../bots/config.ts";
import { CoordinatorError, type GameCoordinator } from "../game/coordinator.ts";

/** Host-only lobby control for seating bots. Mounted only when the server was
 * built with bot support, so a deployment without it simply has no endpoint. */
export function botRoutes(coordinator: GameCoordinator, config: BotRuntimeConfig) {
  const app = new Hono();
  app.post("/games/:id/bots", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddBotRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    try {
      const viewer = (c as unknown as { get(key: "viewer"): ViewerContext }).get("viewer");
      return c.json(
        await coordinator.addBots(c.req.param("id") as GameId, viewer.userId as UserId, {
          displayName: parsed.data.displayName,
          count: parsed.data.count,
          // Provider credentials stay in the environment: the host chooses a
          // model at most, never a key or an endpoint.
          config: resolveSeatConfig(config, parsed.data.config),
        }),
      );
    } catch (error) {
      const code = error instanceof CoordinatorError ? error.code : "VALIDATION";
      return c.json(
        { error: { code } },
        code === "GAME_NOT_FOUND"
          ? 404
          : code === "NOT_GAME_OWNER"
            ? 403
            : code === "GAME_ALREADY_STARTED"
              ? 409
              : 400,
      );
    }
  });
  return app;
}
