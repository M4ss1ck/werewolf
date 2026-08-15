// Global chat storage. Append-only with a hard cap: the table is trimmed on
// every insert, so it stays at roughly CHAT_RETENTION rows forever and there
// is no retention job to schedule or forget.

import type { ChatMessage, ChatMessageId, UserId } from "@werewolf/protocol";
import { CHAT_PAGE_SIZE } from "@werewolf/protocol";
import { desc, gt, lt, lte } from "drizzle-orm";

import type { Db } from "./client.ts";
import { type GlobalChatMessageRow, globalChatMessages } from "./schema.ts";

/** How many messages survive the trim: the floor on how far back anyone can
 * scroll. A trimmed row is unrecoverable, so this is deliberately generous. */
export const CHAT_RETENTION = 1000;

function toMessage(row: GlobalChatMessageRow): ChatMessage {
  return {
    id: row.id as ChatMessageId,
    userId: row.userId as UserId,
    displayName: row.displayName,
    text: row.text,
    createdAt: row.createdAt,
  };
}

export class GlobalChatRepository {
  constructor(private readonly db: Db) {}

  /** Messages newer than `afterId`, newest page first then reversed so the
   * caller always receives oldest-first. Feeds the socket's history frame. */
  async listRecent(afterId = 0, limit = CHAT_PAGE_SIZE): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(globalChatMessages)
      .where(gt(globalChatMessages.id, afterId))
      .orderBy(desc(globalChatMessages.id))
      .limit(limit);
    return rows.reverse().map(toMessage);
  }

  /** The `limit` messages immediately older than `beforeId`, oldest-first.
   * Descending-then-reverse is what makes them the *nearest* older page rather
   * than the start of history. Feeds backwards paging. */
  async listBefore(beforeId: number, limit = CHAT_PAGE_SIZE): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(globalChatMessages)
      .where(lt(globalChatMessages.id, beforeId))
      .orderBy(desc(globalChatMessages.id))
      .limit(limit);
    return rows.reverse().map(toMessage);
  }

  async append(input: {
    userId: UserId;
    displayName: string;
    text: string;
    createdAt: number;
  }): Promise<ChatMessage> {
    const rows = await this.db.insert(globalChatMessages).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("global chat insert returned no row");
    await this.db
      .delete(globalChatMessages)
      .where(lte(globalChatMessages.id, row.id - CHAT_RETENTION));
    return toMessage(row);
  }
}
