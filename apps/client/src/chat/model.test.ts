import type {
  ChatChannel,
  ChatMessage,
  ChatMessageId,
  EventId,
  GameEvent,
  UserId,
  ViewerPlayer,
} from "@werewolf/protocol";
import { describe, expect, test } from "vitest";

import { EMPTY_CHAT_DRAFT, gameChatRows, globalChatRow } from "./model.ts";

const user = (value: string) => value as UserId;

function globalMessage(id: number, authorId = "u1"): ChatMessage {
  return {
    id: id as ChatMessageId,
    userId: user(authorId),
    displayName: "Wire name",
    text: `global ${id}`,
    mentions: id === 1 ? [{ userId: user("u2"), start: 0, length: 3 }] : [],
    createdAt: 1_000 + id,
  };
}

function chatEvent(id: number, channel: ChatChannel, actorUserId?: string): GameEvent {
  const event: GameEvent = {
    id: id as EventId,
    kind: "chat.message",
    scope: "public",
    createdAt: 2_000 + id,
    payload: {
      channel,
      text: `game ${id}`,
      mentions: [],
    },
  };
  if (actorUserId !== undefined) event.actorUserId = user(actorUserId);
  return event;
}

const players: ViewerPlayer[] = [
  { userId: user("u1"), displayName: "Alice", status: "alive" },
  { userId: user("u2"), displayName: "Bob", status: "alive" },
];

describe("canonical chat rows", () => {
  test("maps a global message to the exact client row shape", () => {
    expect(globalChatRow(globalMessage(1))).toEqual({
      id: 1,
      authorId: user("u1"),
      displayName: "Wire name",
      text: "global 1",
      mentions: [{ userId: user("u2"), start: 0, length: 3 }],
      createdAt: 1_001,
    });
    expect(EMPTY_CHAT_DRAFT).toEqual({ text: "", mentions: [] });
  });

  test("keeps only chat events, skips missing actors, groups all channels, and sorts by event id", () => {
    const events: GameEvent[] = [
      chatEvent(4, "grave", "u2"),
      {
        ...chatEvent(3, "public", "u1"),
        kind: "player.eliminated",
        payload: { playerId: user("u2"), role: "villager", cause: "day_vote" },
      },
      chatEvent(2, "wolves", "u1"),
      chatEvent(1, "cult"),
      chatEvent(5, "public", "u1"),
      chatEvent(6, "public"),
    ];

    expect(gameChatRows(events, players)).toEqual({
      public: [
        {
          id: 5,
          authorId: user("u1"),
          displayName: "Alice",
          text: "game 5",
          mentions: [],
          createdAt: 2_005,
        },
      ],
      wolves: [
        {
          id: 2,
          authorId: user("u1"),
          displayName: "Alice",
          text: "game 2",
          mentions: [],
          createdAt: 2_002,
        },
      ],
      grave: [
        {
          id: 4,
          authorId: user("u2"),
          displayName: "Bob",
          text: "game 4",
          mentions: [],
          createdAt: 2_004,
        },
      ],
      cult: [],
    });
  });

  test("uses the actor id when a projected player is unavailable", () => {
    expect(gameChatRows([chatEvent(1, "public", "unknown")], [])).toEqual({
      public: [expect.objectContaining({ displayName: "unknown", authorId: user("unknown") })],
      wolves: [],
      grave: [],
      cult: [],
    });
  });

  test("normalizes a legacy game chat event without mentions", () => {
    const legacyEvent = {
      ...chatEvent(1, "public", "u1"),
      payload: { channel: "public", text: "legacy message" },
    } as unknown as GameEvent;

    expect(gameChatRows([legacyEvent], players).public).toEqual([
      expect.objectContaining({ text: "legacy message", mentions: [] }),
    ]);
  });

  test("rejects malformed null mentions at the mapping boundary", () => {
    const malformedEvent = {
      ...chatEvent(1, "public", "u1"),
      payload: { channel: "public", text: "malformed message", mentions: null },
    } as unknown as GameEvent;

    expect(() => gameChatRows([malformedEvent], players)).toThrow(
      "Invalid game chat event mentions",
    );
  });
});
