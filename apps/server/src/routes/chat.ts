// Global chat: POST sends a message, GET pages backwards through history.
// Realtime delivery belongs to the socket; these are the request/response
// halves, following the project's mutations-over-HTTP split.

import type { GlobalChatRepository } from "@werewolf/db";
import { CHAT_MAX_TEXT_LENGTH, type UserId } from "@werewolf/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ViewerContext } from "../auth/auth.ts";
import type { GlobalChatHub } from "../live/global-chat-hub.ts";

const sendBody = z.object({
  text: z.string().trim().min(1).max(CHAT_MAX_TEXT_LENGTH),
});

/** One message per second per player. A public unmoderated channel with no
 * limit is a spam vector; this is the cheapest thing that closes it. */
const MIN_INTERVAL_MS = 1000;

export function chatRoutes(
  repository: GlobalChatRepository,
  hub: GlobalChatHub,
  now: () => number = Date.now,
) {
  const app = new Hono();
  const lastPostAt = new Map<string, number>();

  app.post("/chat/messages", async (c: Context) => {
    const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    const viewer = c.get("viewer") as ViewerContext;
    const at = now();
    const previous = lastPostAt.get(viewer.userId);
    if (previous !== undefined && at - previous < MIN_INTERVAL_MS)
      return c.json({ error: { code: "RATE_LIMITED" } }, 429);
    lastPostAt.set(viewer.userId, at);
    const message = await repository.append({
      userId: viewer.userId as UserId,
      displayName: viewer.username ?? viewer.userId,
      text: parsed.data.text,
      createdAt: at,
    });
    // Persist first, then fan out.
    hub.publish(message);
    return c.json(message, 201);
  });

  app.get("/chat/messages", async (c: Context) => {
    const before = Number(c.req.query("before"));
    if (!Number.isInteger(before) || before <= 0)
      return c.json({ error: { code: "VALIDATION" } }, 400);
    return c.json({ messages: await repository.listBefore(before) });
  });

  return app;
}
