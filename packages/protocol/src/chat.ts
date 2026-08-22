// Global chat: one channel where signed-in players coordinate games. Distinct
// from in-game chat, which is a game event carried on the game socket.

import { z } from "zod";
import { UserIdSchema } from "./ids.ts";

export const CHAT_MAX_MENTION_RECIPIENTS = 8;
export const CHAT_MENTION_SEARCH_MIN_LENGTH = 3;

export const ChatMentionSchema = z.object({
  userId: UserIdSchema,
  start: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});
export type ChatMention = z.infer<typeof ChatMentionSchema>;

export type ChatContentInput = { text: string; mentions?: ChatMention[] };
export type ChatContent = { text: string; mentions: ChatMention[] };

/** `id INTEGER PRIMARY KEY` on the global_chat_messages row; the paging cursor. */
export const ChatMessageIdSchema = z.number().int().nonnegative().brand("ChatMessageId");
export type ChatMessageId = z.infer<typeof ChatMessageIdSchema>;

export const ChatMessageSchema = z.object({
  id: ChatMessageIdSchema,
  userId: UserIdSchema,
  displayName: z.string().min(1),
  text: z.string().min(1),
  mentions: z.array(ChatMentionSchema),
  createdAt: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** How many messages a history frame or an older page carries. */
export const CHAT_PAGE_SIZE = 50;
/** Longest message the server accepts. */
export const CHAT_MAX_TEXT_LENGTH = 500;

/** Normalize message text and structured UTF-16 mention ranges once at the wire boundary. */
export function normalizeChatContent(input: ChatContentInput): ChatContent | undefined {
  const { text } = input;
  const rawMentions = input.mentions ?? [];

  for (const mention of rawMentions) {
    if (
      typeof mention.userId !== "string" ||
      mention.userId.length === 0 ||
      !Number.isInteger(mention.start) ||
      mention.start < 0 ||
      !Number.isInteger(mention.length) ||
      mention.length <= 0
    ) {
      return undefined;
    }
  }

  for (const mention of rawMentions) {
    if (mention.start + mention.length > text.length) return undefined;
  }

  const mentions = [...rawMentions].sort(
    (left, right) =>
      left.start - right.start ||
      left.length - right.length ||
      (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0),
  );
  for (let index = 1; index < mentions.length; index += 1) {
    const previous = mentions[index - 1]!;
    const current = mentions[index]!;
    if (current.start < previous.start + previous.length) return undefined;
  }

  if (new Set(mentions.map((mention) => mention.userId)).size > CHAT_MAX_MENTION_RECIPIENTS) {
    return undefined;
  }

  const leading = text.length - text.trimStart().length;
  const trailingEnd = text.trimEnd().length;
  if (
    mentions.some(
      (mention) => mention.start < leading || mention.start + mention.length > trailingEnd,
    )
  ) {
    return undefined;
  }

  const canonicalText = text.slice(leading, trailingEnd);
  if (canonicalText.length < 1 || canonicalText.length > CHAT_MAX_TEXT_LENGTH) return undefined;

  return {
    text: canonicalText,
    mentions: mentions.map((mention) => ({ ...mention, start: mention.start - leading })),
  };
}

export const ChatContentSchema = z
  .object({
    text: z.string(),
    mentions: z.array(ChatMentionSchema).optional(),
  })
  .transform((input, context) => {
    const normalized =
      input.mentions === undefined
        ? normalizeChatContent({ text: input.text })
        : normalizeChatContent({ text: input.text, mentions: input.mentions });
    if (normalized === undefined) {
      context.addIssue({ code: "custom", message: "Invalid chat content" });
      return z.NEVER;
    }
    return normalized;
  });

export function normalizeMentionSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

export const ChatSubscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  cursor: ChatMessageIdSchema,
  readCursor: ChatMessageIdSchema.optional(),
});
export type ChatSubscribeFrame = z.infer<typeof ChatSubscribeFrameSchema>;

export type ChatServerFrame =
  | {
      type: "history";
      messages: ChatMessage[];
      cursor: ChatMessageId;
      oldestRetainedId: ChatMessageId;
      hasOlder: boolean;
      historyTruncated: boolean;
    }
  | { type: "message"; message: ChatMessage };

/** Runtime validation for frames arriving from the server over the socket. */
export const ChatServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("history"),
    messages: z.array(ChatMessageSchema),
    cursor: ChatMessageIdSchema,
    oldestRetainedId: ChatMessageIdSchema,
    hasOlder: z.boolean(),
    historyTruncated: z.boolean(),
  }),
  z.object({
    type: z.literal("message"),
    message: ChatMessageSchema,
  }),
]);
