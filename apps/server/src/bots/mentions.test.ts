import { describe, expect, test } from "bun:test";
import type { GameId, PhaseId, UserId } from "@werewolf/protocol";
import { composeBotChatContent, truncateUtf16 } from "./mentions.ts";
import type { BotDecision, BotDecisionInput, BotMentionCandidate } from "./types.ts";

const id = (value: string) => value as UserId;
const candidate = (
  number: number,
  userId: string,
  displayName: string,
  channels: BotMentionCandidate["channels"] = ["public"],
): BotMentionCandidate => ({ id: number, userId: id(userId), displayName, channels });

function input(overrides: Partial<BotDecisionInput> = {}): BotDecisionInput {
  return {
    decisionId: "g:p0:1:0",
    gameId: "g" as GameId,
    playerId: id("p0"),
    phase: "discussion",
    phaseId: 1 as PhaseId,
    remainingMs: 1_000,
    config: {
      botId: "test",
      provider: "fake",
      model: null,
      temperature: 0,
      maxOutputTokens: 100,
      timeoutMs: 1_000,
    },
    playerView: {} as BotDecisionInput["playerView"],
    visibleEvents: [],
    phaseChat: [],
    directMentions: [],
    digest: [],
    legalActions: [],
    speakableChannels: ["public"],
    mentionCandidates: [],
    ...overrides,
  };
}

function decision(overrides: Partial<BotDecision> = {}): BotDecision {
  return {
    actionId: null,
    say: "hello",
    channel: "public",
    mentionIds: [],
    done: false,
    ...overrides,
  };
}

describe("bot chat mentions", () => {
  test("builds stable prefix tokens and exact ranges", () => {
    const result = composeBotChatContent(
      decision({ mentionIds: [2, 1], say: "watch out" }),
      input({
        mentionCandidates: [candidate(1, "a", "Alex"), candidate(2, "b", "Blair")],
      }),
      new Set([id("a"), id("b")]),
    );
    expect(result).toEqual({
      text: "@Blair @Alex watch out",
      mentions: [
        { userId: id("b"), start: 0, length: 6 },
        { userId: id("a"), start: 7, length: 5 },
      ],
    });
  });

  test("duplicate display names still address the selected stable user id", () => {
    const result = composeBotChatContent(
      decision({ mentionIds: [2], say: null }),
      input({
        mentionCandidates: [candidate(1, "user-a", "Alex"), candidate(2, "user-b", "Alex")],
      }),
      new Set([id("user-a"), id("user-b")]),
    );
    expect(result).toEqual({
      text: "@Alex",
      mentions: [{ userId: id("user-b"), start: 0, length: 5 }],
    });
  });

  test("drops stale, repeated, wrong-channel and unknown choices but keeps speech", () => {
    const result = composeBotChatContent(
      decision({ mentionIds: [1, 1, 2, 3, 9] }),
      input({
        mentionCandidates: [
          candidate(1, "a", "Alex"),
          candidate(2, "b", "Blair", ["wolves"]),
          candidate(3, "c", "Casey"),
        ],
      }),
      new Set([id("a")]),
    );
    expect(result).toEqual({
      text: "@Alex hello",
      mentions: [{ userId: id("a"), start: 0, length: 5 }],
    });
  });

  test("allows mention-only output and truncates emoji speech by UTF-16 units", () => {
    const mentionOnly = composeBotChatContent(
      decision({ say: null, mentionIds: [1] }),
      input({ mentionCandidates: [candidate(1, "a", "Alex")] }),
      new Set([id("a")]),
    );
    expect(mentionOnly).toEqual({
      text: "@Alex",
      mentions: [{ userId: id("a"), start: 0, length: 5 }],
    });
    expect(truncateUtf16("😀x", 1)).toBe("");
    expect(truncateUtf16("😀x", 2)).toBe("😀");
    expect(
      composeBotChatContent(
        decision({ say: "", mentionIds: [1] }),
        input({ mentionCandidates: [candidate(1, "a", "Alex")] }),
        new Set([id("a")]),
      ),
    ).toEqual(mentionOnly);
  });

  test("drops every impossible prefix token rather than cutting one", () => {
    const result = composeBotChatContent(
      decision({ say: null, mentionIds: [1] }),
      input({ mentionCandidates: [candidate(1, "a", "A".repeat(600))] }),
      new Set([id("a")]),
    );
    expect(result).toBeNull();
  });

  test("reserves the full prefix and truncates emoji speech safely with exact ranges", () => {
    const result = composeBotChatContent(
      decision({ mentionIds: [1], say: "😀".repeat(300) }),
      input({ mentionCandidates: [candidate(1, "a", "A")] }),
      new Set([id("a")]),
    );
    expect(result).toEqual({
      text: `@A ${"😀".repeat(150)}`,
      mentions: [{ userId: id("a"), start: 0, length: 2 }],
    });
    expect(result!.text.length).toBe(303);
    expect(result!.text.slice(0, 2)).toBe("@A");
  });

  test("never cuts a prefix token when the future message is over the limit", () => {
    const result = composeBotChatContent(
      decision({ mentionIds: [1, 2], say: "x".repeat(500) }),
      input({
        mentionCandidates: [candidate(1, "a", "A".repeat(300)), candidate(2, "b", "B".repeat(300))],
      }),
      new Set([id("a"), id("b")]),
    );
    expect(result?.text.startsWith(`@${"A".repeat(300)}`)).toBe(true);
    expect(result?.mentions.length).toBe(1);
    expect(result?.text.length).toBe(500);
    expect(
      result?.text.slice(
        result.mentions[0]!.start,
        result.mentions[0]!.start + result.mentions[0]!.length,
      ),
    ).toBe(`@${"A".repeat(300)}`);
  });
});
