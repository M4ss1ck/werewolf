import { filterVisibleEvents } from "@werewolf/game-engine";
import type { GameId, UserId } from "@werewolf/protocol";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import { CoordinatorError, type GameCoordinator } from "../game/coordinator.ts";
export function eventRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.get("/games/:id/events", async (c) => {
    const id = c.req.param("id") as GameId;
    const userId = (c as unknown as { get(key: "viewer"): ViewerContext }).get("viewer")
      .userId as UserId;
    try {
      const cursor = Number(c.req.query("cursor") ?? 0);
      const state = await coordinator.loadGameStateForViewer(id, userId, "events");
      if (!state) return c.json({ error: { code: "GAME_NOT_FOUND" } }, 404);
      const events = await coordinator.getVisibleEventsForViewer(
        id,
        userId,
        "events",
        Number.isFinite(cursor) ? cursor : 0,
      );
      return c.json({ events: filterVisibleEvents(events, userId, state) });
    } catch (error) {
      const code = error instanceof CoordinatorError ? error.code : "GAME_NOT_FOUND";
      return c.json({ error: { code } }, code === "GAME_NOT_FOUND" ? 404 : 409);
    }
  });
  return app;
}
