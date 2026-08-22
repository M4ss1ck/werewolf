import type { ChatMessage, ChatMessageId, ChatServerFrame, UserId } from "@werewolf/protocol";
import { expect, test } from "vitest";

import {
  CHAT_FIRST_INDEX,
  initialChatState,
  withHistory,
  withMessage,
  withOlderPage,
} from "./chat-state.ts";

function message(id: number, authorId = "u1", text = `message ${id}`): ChatMessage {
  return {
    id: id as ChatMessageId,
    userId: authorId as UserId,
    displayName: "Ana",
    text,
    mentions: [],
    createdAt: 1_000_000 + id,
  };
}

function page(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => message(from + index));
}

function frame(
  messages: ChatMessage[],
  cursor = messages.at(-1)?.id ?? 0,
  oldestRetainedId = 1,
  hasOlder = true,
): Extract<ChatServerFrame, { type: "history" }> {
  return {
    type: "history",
    messages,
    cursor: cursor as ChatMessageId,
    oldestRetainedId: oldestRetainedId as ChatMessageId,
    hasOlder,
    historyTruncated: false,
  };
}

test("history/live race deduplicates by ID and keeps oldest-first order", () => {
  const opened = withHistory(initialChatState, frame(page(1, 3), 3, 1, false));
  const next = withMessage(opened, message(4));
  const reconnected = withHistory(
    next,
    frame([message(3, "new", "frame wins"), message(5)], 5, 1, false),
  );

  expect(reconnected.messages.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
  expect(reconnected.messages.find((row) => row.id === 3)?.text).toBe("frame wins");
  expect(reconnected.cursor).toBe(5);
});

test("a reconnect frame of exactly 50 never replaces held contiguous rows", () => {
  const opened = withHistory(initialChatState, frame(page(1, 50), 50, 1, false));
  const next = withHistory(opened, frame(page(51, 50), 100, 1, false));

  expect(next.messages).toHaveLength(100);
  expect(next.messages[0]!.id).toBe(1);
  expect(next.messages.at(-1)!.id).toBe(100);
});

test("context plus unread merges and server-retired rows are removed", () => {
  const opened = withHistory(initialChatState, frame(page(1, 3), 3, 1, false));
  const next = withHistory(opened, {
    ...frame([message(3), message(4), message(5)], 5, 3, false),
    historyTruncated: true,
  });

  expect(next.messages.map((row) => row.id)).toEqual([3, 4, 5]);
  expect(next.oldestRetainedId).toBe(3);
  expect(next.historyTruncated).toBe(true);
  expect(next.hasOlder).toBe(false);
});

test("retired front rows preserve an overlapping anchor's logical index", () => {
  const opened = withHistory(initialChatState, frame(page(1, 5), 5, 1, false));
  const next = withHistory(opened, frame(page(3, 5), 7, 3, false));

  expect(next.messages.map((row) => row.id)).toEqual([3, 4, 5, 6, 7]);
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX + 2);
});

test("prepends decrement firstItemIndex and preserve an overlapping anchor", () => {
  const opened = withHistory(initialChatState, frame(page(51, 50), 100, 1, true));
  const next = withOlderPage(opened, page(1, 50));

  expect(next.messages[0]!.id).toBe(1);
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX - 50);
  expect(next.hasOlder).toBe(false);
  expect(next.historyTruncated).toBe(false);
});

test("no-overlap history resets to CHAT_FIRST_INDEX", () => {
  const opened = withHistory(initialChatState, frame(page(1, 3), 3, 1, false));
  const next = withHistory(opened, frame(page(100, 2), 101, 100, false));
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX);
});

test("live rows cap at 1000 and move the client retention boundary", () => {
  const opened = withHistory(initialChatState, frame(page(1, 1000), 1000, 1, false));
  const next = withMessage(opened, message(1001));

  expect(next.messages).toHaveLength(1000);
  expect(next.messages[0]!.id).toBe(2);
  expect(next.oldestRetainedId).toBe(2);
  expect(next.historyTruncated).toBe(true);
  expect(next.hasOlder).toBe(false);
});

test("a stale overlapping reconnect cannot regress the client retention boundary", () => {
  const opened = withHistory(initialChatState, frame(page(1, 1000), 1000, 1, false));
  const capped = withMessage(opened, message(1001));
  const reconnected = withHistory(capped, frame(page(2, 1000), 1001, 1, true));

  expect(reconnected.messages[0]!.id).toBe(2);
  expect(reconnected.messages).toHaveLength(1000);
  expect(reconnected.oldestRetainedId).toBe(2);
  expect(reconnected.historyTruncated).toBe(true);
  expect(reconnected.hasOlder).toBe(false);

  const withExpiredFrame = withHistory(
    reconnected,
    frame([message(1, "expired"), ...page(2, 1000)], 1001, 1, true),
  );
  expect(withExpiredFrame.messages[0]!.id).toBe(2);
  expect(withExpiredFrame.messages.some((row) => row.id === 1)).toBe(false);
  expect(withExpiredFrame.oldestRetainedId).toBe(2);
  expect(withExpiredFrame.hasOlder).toBe(false);
});

test("older-page merge deduplicates and retains the logical index", () => {
  const opened = withHistory(initialChatState, frame(page(51, 3), 53, 1, true));
  const next = withOlderPage(opened, [message(49), message(50), message(51)]);

  expect(next.messages.map((row) => row.id)).toEqual([49, 50, 51, 52, 53]);
  expect(next.firstItemIndex).toBe(CHAT_FIRST_INDEX - 2);
});

test("initial metadata and empty state are explicit", () => {
  expect(initialChatState).toMatchObject({
    oldestRetainedId: 0,
    firstItemIndex: CHAT_FIRST_INDEX,
    hasOlder: true,
    historyTruncated: false,
  });
  const empty = withHistory(initialChatState, frame([], 0, 0, false));
  expect(empty.hasOlder).toBe(false);
  expect(empty.historyTruncated).toBe(false);
});
