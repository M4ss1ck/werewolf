import type { EventId, GameId, UserId, ViewerGameSnapshot } from "@werewolf/protocol";
import { expect, test } from "vitest";

import { gameMentionCandidates } from "./candidates.ts";

const snapshot: ViewerGameSnapshot = {
  game: {
    id: "game-1" as GameId,
    name: "Moonlit village",
    ownerUserId: "me" as UserId,
    status: "running",
    day: 1,
    phase: null,
    settings: {
      visibility: "public",
      spectatingEnabled: true,
      durations: { discussion: 60, voting: 60, night: 60 },
    },
  },
  players: [
    { userId: "me" as UserId, displayName: "Me", status: "alive" },
    { userId: "alice" as UserId, displayName: "Alice", status: "alive" },
    { userId: "bot:zed" as UserId, displayName: "Zed", status: "dead", isBot: true },
    { userId: "lobby" as UserId, displayName: "Lobby", status: "lobby" },
    { userId: "spectator" as UserId, displayName: "Spectator", status: "spectator" },
  ],
  me: { userId: "me" as UserId, status: "alive" },
  availableActions: [],
  availableChannels: ["public", "grave"],
  cursor: 0 as EventId,
  serverNow: 0,
};

test("public candidates include living/dead seats, exclude self and non-seats, and sort ids", () => {
  expect(gameMentionCandidates(snapshot, "public")).toEqual([
    { userId: "alice", displayName: "Alice", status: "alive" },
    { userId: "bot:zed", displayName: "Zed", status: "dead", isBot: true },
  ]);
});

test("grave candidates require availability and are dead seats only", () => {
  expect(gameMentionCandidates(snapshot, "grave")).toEqual([
    { userId: "bot:zed", displayName: "Zed", status: "dead", isBot: true },
  ]);
  expect(gameMentionCandidates({ ...snapshot, availableChannels: ["public"] }, "grave")).toEqual(
    [],
  );
});

test("secret candidates fail closed without a known projected member list", () => {
  const secret = {
    ...snapshot,
    availableChannels: ["public", "wolves"] as ViewerGameSnapshot["availableChannels"],
  };
  expect(gameMentionCandidates(secret, "wolves")).toEqual([]);
});

test("wolves and cult candidates use only corresponding known ids and projected fields", () => {
  const secret: ViewerGameSnapshot = {
    ...snapshot,
    players: [
      ...snapshot.players,
      {
        userId: "alpha" as UserId,
        displayName: "Alpha",
        status: "alive" as const,
        isBot: true,
      },
      { userId: "zeta" as UserId, displayName: "Zeta", status: "dead" as const },
      {
        userId: "cultbot" as UserId,
        displayName: "Cult Bot",
        status: "alive" as const,
        isBot: true,
      },
    ],
    availableChannels: ["public", "wolves", "cult"] as ViewerGameSnapshot["availableChannels"],
    knownChannelMemberIds: {
      wolves: ["zeta", "alpha", "me", "unknown"] as UserId[],
      cult: ["cultbot", "unknown"] as UserId[],
    },
  };
  expect(gameMentionCandidates(secret, "wolves")).toEqual([
    { userId: "alpha", displayName: "Alpha", status: "alive", isBot: true },
    { userId: "zeta", displayName: "Zeta", status: "dead" },
  ]);
  expect(gameMentionCandidates(secret, "cult")).toEqual([
    { userId: "cultbot", displayName: "Cult Bot", status: "alive", isBot: true },
  ]);
  expect(gameMentionCandidates({ ...secret, availableChannels: ["public"] }, "wolves")).toEqual([]);
  expect(
    gameMentionCandidates(
      { ...secret, knownChannelMemberIds: { cult: ["cultbot"] as UserId[] } },
      "wolves",
    ),
  ).toEqual([]);
  const noViewer = { ...secret };
  delete noViewer.me;
  expect(gameMentionCandidates(noViewer, "public")).toEqual([]);
});
