import { filterVisibleEvents } from "@werewolf/game-engine";
import type { GameId, UserId } from "@werewolf/protocol";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import type { GameCoordinator } from "../game/coordinator.ts";
export function eventRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.get("/games/:id/events", async (c) => {
    const id = c.req.param("id") as GameId;
    const state = await coordinator.loadGameState(id);
    if (!state) return c.json({ error: { code: "GAME_NOT_FOUND" } }, 404);
    const cursor = Number(c.req.query("cursor") ?? 0);
    const events = await coordinator.getVisibleEvents(id, Number.isFinite(cursor) ? cursor : 0);
    const userId = (c as unknown as { get(key: "viewer"): ViewerContext }).get("viewer")
      .userId as UserId;
    return c.json({ events: filterVisibleEvents(events, userId, state) });
  });
  return app;
}
