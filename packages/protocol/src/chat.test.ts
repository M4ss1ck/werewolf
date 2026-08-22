import { expect, test } from "bun:test";
import type { ChatMention, ChatMessageId } from "./chat.ts";
import {
  CHAT_MAX_MENTION_RECIPIENTS,
  ChatContentSchema,
  ChatMentionSchema,
  ChatMessageSchema,
  ChatServerFrameSchema,
  ChatSubscribeFrameSchema,
  normalizeChatContent,
  normalizeMentionSearch,
} from "./chat.ts";

const mention = (userId: string, start: number, length: number): ChatMention => ({
  userId: userId as ChatMention["userId"],
  start,
  length,
});

test("ChatMentionSchema accepts valid ranges and ChatContentSchema rejects malformed ranges", () => {
  expect(ChatMentionSchema.safeParse(mention("alice", 0, 5)).success).toBe(true);
  for (const range of [
    mention("alice", -1, 5),
    mention("alice", 0.5, 5),
    mention("alice", 0, 0),
    mention("alice", 0, 6),
  ]) {
    expect(ChatContentSchema.safeParse({ text: "@Alex", mentions: [range] }).success).toBe(false);
  }
});

test("mentions cannot overlap, but touching ranges are valid", () => {
  expect(
    ChatContentSchema.safeParse({
      text: "@Alex@Bea",
      mentions: [mention("alice", 0, 5), mention("bea", 4, 4)],
    }).success,
  ).toBe(false);
  expect(
    ChatContentSchema.safeParse({
      text: "@Alex@Bea",
      mentions: [mention("alice", 0, 5), mention("bea", 5, 4)],
    }).success,
  ).toBe(true);
});

test("mention recipient limit counts distinct IDs and preserves repeated IDs", () => {
  const eight = Array.from({ length: CHAT_MAX_MENTION_RECIPIENTS }, (_, index) =>
    mention(`user-${index}`, index * 2, 1),
  );
  expect(ChatContentSchema.safeParse({ text: "@a@b@c@d@e@f@g@h", mentions: eight }).success).toBe(
    true,
  );
  expect(
    ChatContentSchema.safeParse({
      text: "@a@b@c@d@e@f@g@h@i",
      mentions: [...eight, mention("user-8", 16, 2)],
    }).success,
  ).toBe(false);
  expect(
    ChatContentSchema.safeParse({
      text: "@a@a@b@c@d@e@f@g@h",
      mentions: [mention("user-0", 0, 1), ...eight.slice(1), mention("user-0", 16, 2)],
    }).success,
  ).toBe(true);
});

test("mention offsets are UTF-16 units", () => {
  const text = "😀 @Name";
  const result = ChatContentSchema.safeParse({
    text,
    mentions: [mention("name", 3, 5)],
  });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.mentions).toEqual([mention("name", 3, 5)]);
});

test("chat content trims outer whitespace, rebases ranges, and enforces UTF-16 length", () => {
  const result = normalizeChatContent({
    text: "  @Name  ",
    mentions: [mention("name", 2, 5)],
  });
  expect(result).toEqual({ text: "@Name", mentions: [mention("name", 0, 5)] });
  expect(normalizeChatContent({ text: " @Name", mentions: [mention("name", 0, 5)] })).toBe(
    undefined,
  );
  expect(normalizeChatContent({ text: "", mentions: [] })).toBeUndefined();
  expect(normalizeChatContent({ text: "a".repeat(501), mentions: [] })).toBeUndefined();
  expect(normalizeChatContent({ text: "a".repeat(500), mentions: [] })).toEqual({
    text: "a".repeat(500),
    mentions: [],
  });
});

test("mention search removes accents and lowercases without trimming", () => {
  expect(normalizeMentionSearch(" ÁLEx ")).toBe(" alex ");
});

test("ChatMessageSchema requires the mentions array", () => {
  const base = { id: 1, userId: "alice", displayName: "Alex", text: "hello", createdAt: 1 };
  expect(ChatMessageSchema.safeParse(base).success).toBe(false);
  expect(ChatMessageSchema.safeParse({ ...base, mentions: [] }).success).toBe(true);
});

test("chat subscribe distinguishes omitted readCursor from zero", () => {
  const omitted = ChatSubscribeFrameSchema.parse({ type: "subscribe", cursor: 0 });
  const zero = ChatSubscribeFrameSchema.parse({ type: "subscribe", cursor: 0, readCursor: 0 });
  expect(omitted).not.toHaveProperty("readCursor");
  expect(zero.readCursor).toBe(0 as ChatMessageId);
});

test("history frames require retained-window metadata", () => {
  const frame = {
    type: "history",
    messages: [],
    cursor: 0,
    oldestRetainedId: 0,
    hasOlder: false,
    historyTruncated: false,
  };
  expect(ChatServerFrameSchema.safeParse(frame).success).toBe(true);
  expect(
    ChatServerFrameSchema.safeParse({
      type: "history",
      messages: [],
      cursor: 0,
    }).success,
  ).toBe(false);
});
