// PATCH /me/username: the signed-in player chooses the name the roster shows.
// GET /me/stats: their lifetime record over finished games.

import type { Db, GameRepository } from "@werewolf/db";
import { normalizeMentionSearch, type UserId } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ViewerContext } from "../auth/auth.ts";
import { authUser } from "../auth/schema.ts";

// Letters, digits, spaces, hyphens and underscores, and it must start and
// end with a letter or digit. Not unique: two villagers may share a name.
const usernameBody = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*[\p{L}\p{N}]$/u),
});

export function meRoutes(db: Db, repository: GameRepository) {
  const app = new Hono();
  app.patch("/me/username", async (c: Context) => {
    const parsed = usernameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "INVALID_USERNAME" } }, 400);
    const { userId } = c.get("viewer") as ViewerContext;
    const username = parsed.data.username;
    await db
      .update(authUser)
      .set({ username, usernameSearch: normalizeMentionSearch(username), updatedAt: new Date() })
      .where(eq(authUser.id, userId));
    return c.json({ userId, username });
  });
  // Always the viewer's own record: the id comes from the session, never the
  // request, so there is nothing to authorize beyond being signed in.
  app.get("/me/stats", async (c: Context) => {
    const { userId } = c.get("viewer") as ViewerContext;
    return c.json(await repository.getUserStats(userId as UserId));
  });
  return app;
}
