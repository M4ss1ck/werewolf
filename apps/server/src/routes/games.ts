import type { GameId, UserId } from "@werewolf/protocol";
import { PresetIdSchema } from "@werewolf/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ViewerContext } from "../auth/auth.ts";
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
      preset: PresetIdSchema.optional(),
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

/** A viewer who may take a seat: the roster needs a name for them. */
function player(c: Context) {
  const context = c.get("viewer") as ViewerContext;
  if (!context.username) throw new CoordinatorError("USERNAME_REQUIRED");
  return { userId: context.userId as UserId, username: context.username };
}
function failure(c: Context, error: unknown) {
  const code =
    error instanceof CoordinatorError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string")
      ? error.code
      : "VALIDATION";
  const status =
    code === "GAME_NOT_FOUND"
      ? 404
      : code === "NOT_GAME_OWNER" ||
          code === "NOT_A_MEMBER" ||
          code === "ACTION_NOT_AVAILABLE" ||
          code === "USERNAME_REQUIRED"
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
  app.get("/", async (c) => {
    // The listing is the one route open to signed-out visitors, so the viewer
    // is optional: anonymous callers see public games only, an authenticated
    // one also sees private games they participate in.
    const viewer = (c as Context).get("viewer") as ViewerContext | undefined;
    const scope = c.req.query("scope") ?? "browse";
    if (scope !== "browse" && scope !== "mine")
      return c.json({ error: { code: "VALIDATION" } }, 400);
    if (scope === "mine" && !viewer) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    return c.json(await coordinator.listGameSummaries(viewer?.userId as UserId | undefined, scope));
  });
  app.post("/", async (c) => {
    const parsed = gameBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    try {
      const { userId, username } = player(c);
      const game = await coordinator.createGame({
        ownerUserId: userId,
        displayName: username,
        ...parsed.data,
      });
      if (!game) return c.json({ error: { code: "GAME_NOT_FOUND" } }, 404);
      return c.json({ gameId: game.id });
    } catch (error) {
      return failure(c, error);
    }
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
  app.get("/:id/invitation", async (c) => {
    try {
      const context = (c as Context).get("viewer") as ViewerContext;
      return c.json(
        await coordinator.ownerInvitation(c.req.param("id") as GameId, {
          userId: context.userId as UserId,
          username: context.username,
        }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete("/:id/membership", async (c) => {
    try {
      await coordinator.leaveLobby(c.req.param("id") as GameId, viewer(c).userId as UserId);
      return c.body(null, 204);
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
