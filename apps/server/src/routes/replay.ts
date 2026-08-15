import { filterVisibleEvents, projectSnapshot } from "@werewolf/game-engine";
import type { GameId, UserId } from "@werewolf/protocol";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import type { GameCoordinator } from "../game/coordinator.ts";
export function replayRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.get("/games/:id/replay", async (c) => {
    const id = c.req.param("id") as GameId;
    const game = await coordinator.getGame(id);
    if (!game) return c.json({ error: { code: "GAME_NOT_FOUND" } }, 404);
    if (game.status !== "finished") return c.json({ error: { code: "GAME_NOT_STARTED" } }, 409);
    const state = await coordinator.loadGameState(id);
    if (!state) return c.json({ error: { code: "GAME_NOT_FOUND" } }, 404);
    const userId = (c as unknown as { get(key: "viewer"): ViewerContext }).get("viewer")
      .userId as UserId;
    // The game is finished, so the projection reveals every role; the events
    // are filtered like any live stream, keeping audit.* server rows server-side.
    return c.json({
      snapshot: projectSnapshot(state, userId, 0, Date.now()),
      events: filterVisibleEvents(await coordinator.getVisibleEvents(id), userId, state),
    });
  });
  return app;
}
