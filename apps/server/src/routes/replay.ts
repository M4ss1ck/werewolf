import type { GameId } from "@werewolf/protocol";
import { Hono } from "hono";
import type { GameCoordinator } from "../game/coordinator.ts";
export function replayRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.get("/games/:id/replay", async (c) => {
    const id = c.req.param("id") as GameId;
    const game = await coordinator.getGame(id);
    if (!game) return c.json({ error: { code: "GAME_NOT_FOUND" } }, 404);
    if (game.status !== "finished") return c.json({ error: { code: "GAME_NOT_STARTED" } }, 409);
    const state = await coordinator.loadGameState(id);
    return c.json({ state, events: await coordinator.getVisibleEvents(id) });
  });
  return app;
}
