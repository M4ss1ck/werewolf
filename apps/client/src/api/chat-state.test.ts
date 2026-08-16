import type { ChatMessage, ChatMessageId, UserId } from "@werewolf/protocol";
import { expect, test } from "vitest";

import {
  CHAT_FIRST_INDEX,
  initialChatState,
  withHistory,
  withMessage,
  withOlderPage,
} from "./chat-state.ts";

function message(id: number): ChatMessage {
  return {
    id: id as ChatMessageId,
    userId: "u1" as UserId,
    displayName: "Ana",
    text: `message ${id}`,
    createdAt: 1_000_000 + id,
  };
}

function page(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => message(from + index));
}

test("a full first history page leaves older messages available", () => {
  const state = withHistory(initialChatState, page(1, 50), 50 as ChatMessageId);

  expect(state.messages).toHaveLength(50);
  expect(state.cursor).toBe(50);
  expect(state.hasOlder).toBe(true);
});

test("a short first history page means there is nothing older", () => {
  const state = withHistory(initialChatState, page(1, 3), 3 as ChatMessageId);

  expect(state.hasOlder).toBe(false);
});

test("a reconnect history appends without disturbing hasOlder", () => {
  const opened = withHistory(initialChatState, page(1, 50), 50 as ChatMessageId);

  const reconnected = withHistory(opened, page(51, 2), 52 as ChatMessageId);

  expect(reconnected.messages).toHaveLength(52);
  expect(reconnected.cursor).toBe(52);
  expect(reconnected.hasOlder).toBe(true);
});

test("a full page history frame onto a non-empty state is treated as a cold open", () => {
  const opened = withHistory(initialChatState, page(151, 50), 200 as ChatMessageId);
  const scrolled = withOlderPage(opened, page(101, 50));

  const reconnected = withHistory(scrolled, page(271, 50), 320 as ChatMessageId);

  expect(reconnected.messages).toHaveLength(50);
  expect(reconnected.messages[0]!.text).toBe("message 271");
  expect(reconnected.cursor).toBe(320);
  expect(reconnected.firstItemIndex).toBe(CHAT_FIRST_INDEX);
  expect(reconnected.hasOlder).toBe(true);
});

test("a live message is appended and moves the cursor", () => {
  const opened = withHistory(initialChatState, page(1, 3), 3 as ChatMessageId);

  const next = withMessage(opened, message(4));

  expect(next.messages.at(-1)!.text).toBe("message 4");
  expect(next.cursor).toBe(4);
});

test("a live message already covered by the cursor is ignored", () => {
  const opened = withHistory(initialChatState, page(1, 3), 3 as ChatMessageId);

  const next = withMessage(opened, message(2));

  expect(next).toBe(opened);
});

test("a live message exactly at the cursor is ignored", () => {
  const opened = withHistory(initialChatState, page(1, 3), 3 as ChatMessageId);

  const next = withMessage(opened, message(3));

  expect(next).toBe(opened);
});

test("an older page is prepended and decrements firstItemIndex", () => {
  const opened = withHistory(initialChatState, page(51, 50), 100 as ChatMessageId);

  const next = withOlderPage(opened, page(1, 50));

  expect(next.messages).toHaveLength(100);
  expect(next.messages[0]!.text).toBe("message 1");
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX - 50);
  expect(next.hasOlder).toBe(true);
});

test("a short older page ends paging", () => {
  const opened = withHistory(initialChatState, page(11, 50), 60 as ChatMessageId);

  const next = withOlderPage(opened, page(1, 10));

  expect(next.hasOlder).toBe(false);
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX - 10);
});

test("an empty older page ends paging and changes nothing else", () => {
  const opened = withHistory(initialChatState, page(1, 50), 50 as ChatMessageId);

  const next = withOlderPage(opened, []);

  expect(next.hasOlder).toBe(false);
  expect(next.messages).toHaveLength(50);
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX);
});
