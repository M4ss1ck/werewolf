// Global chat: POST sends a message, GET pages backwards through history.
// Realtime delivery belongs to the socket; these are the request/response
// halves, following the project's mutations-over-HTTP split.

import type { Db, GlobalChatRepository } from "@werewolf/db";
import { CHAT_MENTION_SEARCH_MIN_LENGTH, ChatContentSchema, type UserId } from "@werewolf/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ViewerContext } from "../auth/auth.ts";
import { findGlobalMentionCandidates, validateGlobalMentions } from "../chat/global-mentions.ts";
import type { GlobalChatHub } from "../live/global-chat-hub.ts";

/** One message per second per player. A public unmoderated channel with no
 * limit is a spam vector; this is the cheapest thing that closes it. */
const MIN_INTERVAL_MS = 1000;
const SEARCH_WINDOW_MS = 10_000;
const SEARCH_LIMIT = 30;
const SEARCH_MAX_UTF16_UNITS = 24;

export function chatRoutes(
  db: Db,
  repository: GlobalChatRepository,
  hub: GlobalChatHub,
  now: () => number = Date.now,
) {
  const app = new Hono();
  const lastPostAt = new Map<string, number>();
  const acceptedSearchAt = new Map<UserId, number[]>();

  app.post("/chat/messages", async (c: Context) => {
    const parsed = ChatContentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION" } }, 400);
    const viewer = c.get("viewer") as ViewerContext;
    const senderId = viewer.userId as UserId;
    if (!(await validateGlobalMentions(db, senderId, parsed.data)))
      return c.json({ error: { code: "INVALID_MENTION" } }, 400);
    const at = now();
    const previous = lastPostAt.get(viewer.userId);
    if (previous !== undefined && at - previous < MIN_INTERVAL_MS)
      return c.json({ error: { code: "RATE_LIMITED" } }, 429);
    lastPostAt.set(viewer.userId, at);
    const message = await repository.append({
      userId: senderId,
      displayName: viewer.username ?? viewer.userId,
      content: parsed.data,
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

  app.get("/chat/mention-candidates", async (c: Context) => {
    const viewer = c.get("viewer") as ViewerContext;
    const query = (c.req.query("q") ?? "").trim();
    if (
      Array.from(query).length < CHAT_MENTION_SEARCH_MIN_LENGTH ||
      query.length > SEARCH_MAX_UTF16_UNITS
    )
      return c.json({ error: { code: "VALIDATION" } }, 400);

    const viewerId = viewer.userId as UserId;
    const at = now();
    const timestamps = (acceptedSearchAt.get(viewerId) ?? []).filter(
      (timestamp) => timestamp >= at - SEARCH_WINDOW_MS,
    );
    if (timestamps.length >= SEARCH_LIMIT) return c.json({ error: { code: "RATE_LIMITED" } }, 429);
    timestamps.push(at);
    acceptedSearchAt.set(viewerId, timestamps);

    return c.json(await findGlobalMentionCandidates(db, viewerId, query));
  });

  return app;
}
