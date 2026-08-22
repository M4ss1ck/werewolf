// Global chat: append-only persistence with a retained subscription window.

import {
  CHAT_PAGE_SIZE,
  type ChatContent,
  ChatMentionSchema,
  type ChatMessage,
  type ChatMessageId,
  type UserId,
} from "@werewolf/protocol";
import { asc, desc, gt, lt, lte, sql } from "drizzle-orm";

import type { Db } from "./client.ts";
import { type GlobalChatMessageRow, globalChatMessages } from "./schema.ts";

/** How many messages survive the trim: the floor on how far back anyone can
 * scroll. A trimmed row is unrecoverable, so this is deliberately generous. */
export const CHAT_RETENTION = 1000;

type GlobalChatWriter = Pick<Db, "insert" | "delete">;

export type GlobalChatWindow = {
  messages: ChatMessage[];
  cursor: ChatMessageId;
  oldestRetainedId: ChatMessageId;
  hasOlder: boolean;
  historyTruncated: boolean;
};

function parseMentions(value: string): ChatMessage["mentions"] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return [];
  }
  const parsed = ChatMentionSchema.array().safeParse(decoded);
  return parsed.success ? parsed.data : [];
}

function toMessage(row: GlobalChatMessageRow): ChatMessage {
  return {
    id: row.id as ChatMessageId,
    userId: row.userId as UserId,
    displayName: row.displayName,
    text: row.text,
    mentions: parseMentions(row.mentionsJson),
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

  async listSubscriptionWindow(
    deliveryCursor: ChatMessageId,
    readCursor?: ChatMessageId,
  ): Promise<GlobalChatWindow> {
    return this.db.transaction(async (tx) => {
      const [bounds] = await tx
        .select({
          oldest: sql<number | null>`min(${globalChatMessages.id})`,
          latest: sql<number | null>`max(${globalChatMessages.id})`,
        })
        .from(globalChatMessages);
      const oldest = bounds?.oldest ?? 0;
      const latest = bounds?.latest ?? 0;
      if (latest === 0) {
        return {
          messages: [],
          cursor: 0 as ChatMessageId,
          oldestRetainedId: 0 as ChatMessageId,
          hasOlder: false,
          historyTruncated: false,
        };
      }

      let rows: GlobalChatMessageRow[];
      let historyTruncated = false;
      const latestPage = () =>
        tx
          .select()
          .from(globalChatMessages)
          .orderBy(desc(globalChatMessages.id))
          .limit(CHAT_PAGE_SIZE);
      const allRows = () =>
        tx.select().from(globalChatMessages).orderBy(asc(globalChatMessages.id));

      const cursorBeyondLatest =
        deliveryCursor > latest || (readCursor !== undefined && readCursor > latest);
      if (cursorBeyondLatest) {
        rows = await latestPage();
      } else if (deliveryCursor > 0) {
        if (deliveryCursor < oldest) {
          rows = await allRows();
          historyTruncated = true;
        } else {
          rows = await tx
            .select()
            .from(globalChatMessages)
            .where(gt(globalChatMessages.id, deliveryCursor))
            .orderBy(asc(globalChatMessages.id));
        }
      } else if (readCursor === undefined) {
        rows = await latestPage();
      } else if (readCursor === 0 || readCursor < oldest) {
        rows = await allRows();
        historyTruncated = readCursor === 0 ? oldest > 1 : true;
      } else {
        const context = await tx
          .select()
          .from(globalChatMessages)
          .where(lte(globalChatMessages.id, readCursor))
          .orderBy(desc(globalChatMessages.id))
          .limit(CHAT_PAGE_SIZE);
        const after = await tx
          .select()
          .from(globalChatMessages)
          .where(gt(globalChatMessages.id, readCursor))
          .orderBy(asc(globalChatMessages.id));
        rows = [...context, ...after];
      }

      const uniqueRows = new Map<number, GlobalChatMessageRow>();
      for (const row of rows) uniqueRows.set(row.id, row);
      rows = [...uniqueRows.values()].sort((left, right) => left.id - right.id);
      const messages = rows.map(toMessage);
      return {
        messages,
        cursor: latest as ChatMessageId,
        oldestRetainedId: oldest as ChatMessageId,
        hasOlder: rows.length > 0 && rows[0]!.id > oldest,
        historyTruncated,
      };
    });
  }

  async append(
    input: {
      userId: UserId;
      displayName: string;
      content: ChatContent;
      createdAt: number;
    },
    writer: GlobalChatWriter = this.db,
  ): Promise<ChatMessage> {
    const rows = await writer
      .insert(globalChatMessages)
      .values({
        userId: input.userId,
        displayName: input.displayName,
        text: input.content.text,
        mentionsJson: JSON.stringify(input.content.mentions),
        createdAt: input.createdAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("global chat insert returned no row");
    await writer
      .delete(globalChatMessages)
      .where(lte(globalChatMessages.id, row.id - CHAT_RETENTION));
    return toMessage(row);
  }
}
