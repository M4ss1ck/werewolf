import { type GameId, GameplayCommandSchema, type UserId } from "@werewolf/protocol";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import { CoordinatorError, type GameCoordinator } from "../game/coordinator.ts";
export function commandRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.post("/games/:id/commands", async (c) => {
    const parsed = GameplayCommandSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    try {
      return c.json(
        await coordinator.executeCommand(
          c.req.param("id") as GameId,
          (c as unknown as { get(key: "viewer"): ViewerContext }).get("viewer").userId as UserId,
          parsed.data,
        ),
      );
    } catch (error) {
      const code = error instanceof CoordinatorError ? error.code : "VALIDATION";
      return c.json(
        { error: { code } },
        code === "GAME_NOT_FOUND" ? 404 : code === "NOT_A_MEMBER" ? 403 : 409,
      );
    }
  });
  return app;
}
