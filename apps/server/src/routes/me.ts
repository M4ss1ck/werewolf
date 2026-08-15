// PATCH /me/username: the signed-in player chooses the name the roster shows.

import type { Db } from "@werewolf/db";
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

export function meRoutes(db: Db) {
  const app = new Hono();
  app.patch("/me/username", async (c: Context) => {
    const parsed = usernameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "INVALID_USERNAME" } }, 400);
    const { userId } = c.get("viewer") as ViewerContext;
    const username = parsed.data.username;
    await db
      .update(authUser)
      .set({ username, updatedAt: new Date() })
      .where(eq(authUser.id, userId));
    return c.json({ userId, username });
  });
  return app;
}
