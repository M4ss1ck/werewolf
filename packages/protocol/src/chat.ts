// Global chat: one channel where signed-in players coordinate games. Distinct
// from in-game chat, which is a game event carried on the game socket.

import { z } from "zod";
import { UserIdSchema } from "./ids.ts";

/** `id INTEGER PRIMARY KEY` on the global_chat_messages row; the paging cursor. */
export const ChatMessageIdSchema = z.number().int().nonnegative().brand("ChatMessageId");
export type ChatMessageId = z.infer<typeof ChatMessageIdSchema>;

export const ChatMessageSchema = z.object({
  id: ChatMessageIdSchema,
  userId: UserIdSchema,
  displayName: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** How many messages a history frame or an older page carries. */
export const CHAT_PAGE_SIZE = 50;
/** Longest message the server accepts. */
export const CHAT_MAX_TEXT_LENGTH = 500;

export const ChatSubscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  cursor: ChatMessageIdSchema,
});
export type ChatSubscribeFrame = z.infer<typeof ChatSubscribeFrameSchema>;

export type ChatServerFrame =
  | { type: "history"; messages: ChatMessage[]; cursor: ChatMessageId }
  | { type: "message"; message: ChatMessage };

/** Runtime validation for frames arriving from the server over the socket. */
export const ChatServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("history"),
    messages: z.array(ChatMessageSchema),
    cursor: ChatMessageIdSchema,
  }),
  z.object({
    type: z.literal("message"),
    message: ChatMessageSchema,
  }),
]);
