import { GameEntryModeSchema, type GameEntryReference, type UserId } from "@werewolf/protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { ViewerContext } from "../auth/auth.ts";
import type { GameCoordinator } from "../game/coordinator.ts";
import { GameAccessError } from "../game/game-access.ts";

const reference = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invitation"), code: z.string() }).strict(),
  z.object({ kind: z.literal("public-game"), gameId: z.string().min(1) }).strict(),
]);
const admission = z.object({ reference, mode: GameEntryModeSchema }).strict();

function viewerOf(c: { get(key: "viewer"): unknown }) {
  return c.get("viewer") as ViewerContext;
}

function failure(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  const code = error instanceof GameAccessError ? error.code : "VALIDATION";
  const status =
    code === "GAME_NOT_FOUND" || code === "INVITATION_NOT_FOUND"
      ? 404
      : code === "UNAUTHENTICATED"
        ? 401
        : code === "INVITATION_ACCESS_DENIED" ||
            code === "NOT_GAME_OWNER" ||
            code === "USERNAME_REQUIRED"
          ? 403
          : code === "CONFLICT" || code === "GAME_ALREADY_STARTED" || code === "GAME_NOT_STARTED"
            ? 409
            : 400;
  return c.json({ error: { code } }, status);
}

function queryReference(c: { req: { query(name: string): string | undefined } }) {
  const code = c.req.query("code");
  const gameId = c.req.query("gameId");
  if ((code === undefined) === (gameId === undefined)) return null;
  return code !== undefined
    ? ({ kind: "invitation", code } as const)
    : ({ kind: "public-game", gameId: gameId! } as const);
}

export function gameEntryRoutes(coordinator: GameCoordinator) {
  const app = new Hono();
  app.get("/game-entry", async (c) => {
    const ref = queryReference(c);
    if (!ref) return c.json({ error: { code: "VALIDATION" } }, 400);
    try {
      const viewer = viewerOf(c);
      return c.json(
        await coordinator.previewGameEntry(ref as GameEntryReference, {
          userId: viewer.userId as UserId,
          username: viewer.username,
        }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/game-entry", async (c) => {
    const parsed = admission.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    try {
      const viewer = viewerOf(c);
      return c.json(
        await coordinator.admitGameEntry(
          parsed.data.reference,
          {
            userId: viewer.userId as UserId,
            username: viewer.username,
          },
          parsed.data.mode,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}
