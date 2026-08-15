import type { GameId, UserId } from "@werewolf/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { GameCoordinator } from "../game/coordinator.ts";
import { CoordinatorError } from "../game/coordinator.ts";

const gameBody = z.object({
  name: z.string().min(1),
  visibility: z.enum(["public", "private"]).default("public"),
  scheduledAt: z.number().int().positive().optional(),
  settings: z
    .object({
      discussionDurationMs: z.number().int().nonnegative().default(60_000),
      votingDurationMs: z.number().int().nonnegative().default(60_000),
      nightDurationMs: z.number().int().nonnegative().default(60_000),
      spectatingEnabled: z.boolean().default(true),
    })
    .default({
      discussionDurationMs: 60_000,
      votingDurationMs: 60_000,
      nightDurationMs: 60_000,
      spectatingEnabled: true,
    }),
});
const patchBody = z.object({
  name: z.string().min(1).optional(),
  visibility: z.enum(["public", "private"]).optional(),
});
const viewer = (c: Context) => c.get("viewer") as { userId: string };
function failure(c: Context, error: unknown) {
  const code = error instanceof CoordinatorError ? error.code : "VALIDATION";
  const status =
    code === "GAME_NOT_FOUND"
      ? 404
      : code === "NOT_GAME_OWNER" || code === "NOT_A_MEMBER" || code === "ACTION_NOT_AVAILABLE"
        ? 403
        : code === "UNAUTHENTICATED"
          ? 401
          : code === "CONFLICT" ||
              code === "PHASE_CLOSED" ||
              code === "PHASE_MISMATCH" ||
              code === "GAME_ALREADY_STARTED"
            ? 409
            : 400;
  return c.json({ error: { code } }, status);
}

export function gamesRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.get("/", async (c) => c.json(await coordinator.listPublicGames()));
  app.post("/", async (c) => {
    const parsed = gameBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    return c.json(
      await coordinator.createGame({ ownerUserId: viewer(c).userId as UserId, ...parsed.data }),
    );
  });
  app.get("/:id", async (c) => {
    try {
      return c.json(
        await coordinator.snapshot(c.req.param("id") as GameId, viewer(c).userId as UserId),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.patch("/:id", async (c) => {
    const parsed = patchBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    try {
      return c.json(
        await coordinator.updateGame(
          c.req.param("id") as GameId,
          viewer(c).userId as UserId,
          parsed.data,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/:id/join", async (c) => {
    try {
      return c.json(
        await coordinator.joinGame(c.req.param("id") as GameId, viewer(c).userId as UserId),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/:id/spectate", async (c) => {
    try {
      return c.json(
        await coordinator.spectateGame(c.req.param("id") as GameId, viewer(c).userId as UserId),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete("/:id/membership", async (c) => {
    try {
      return c.json(
        await coordinator.leaveLobby(c.req.param("id") as GameId, viewer(c).userId as UserId),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete("/:id/players/:userId", async (c) => {
    try {
      return c.json(
        await coordinator.kickLobbyPlayer(
          c.req.param("id") as GameId,
          viewer(c).userId as UserId,
          c.req.param("userId") as UserId,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/:id/start", async (c) => {
    try {
      return c.json(
        await coordinator.startGame(c.req.param("id") as GameId, viewer(c).userId as UserId),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/:id/cancel", async (c) => {
    try {
      return c.json(
        await coordinator.cancelGame(c.req.param("id") as GameId, viewer(c).userId as UserId),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}
