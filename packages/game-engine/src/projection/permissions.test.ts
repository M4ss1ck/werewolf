import { expect, test } from "bun:test";
import type { GameEvent, UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { canViewEvent } from "./permissions.ts";

function player(id: string, overrides: Partial<PlayerState>): PlayerState {
  return {
    id: id as UserId,
    status: "alive",
    originalRole: "villager",
    role: "villager",
    faction: "village",
    roleState: {},
    phaseState: { phaseId: 1 as PlayerState["phaseState"]["phaseId"] },
    ...overrides,
  } as PlayerState;
}

const state = {
  ownerUserId: "startingWolf" as UserId,
  players: {
    startingWolf: player("startingWolf", {
      originalRole: "werewolf",
      role: "werewolf",
      faction: "wolves",
    }),
    deadWolf: player("deadWolf", {
      originalRole: "werewolf",
      role: "werewolf",
      faction: "wolves",
      status: "dead",
    }),
    converted: player("converted", {
      originalRole: "cursed",
      role: "werewolf",
      faction: "wolves",
      wolfSinceEventId: 50 as NonNullable<PlayerState["wolfSinceEventId"]>,
    }),
    convertedWithoutMarker: player("convertedWithoutMarker", {
      originalRole: "cursed",
      role: "werewolf",
      faction: "wolves",
    }),
    villager: player("villager", {}),
    wolfFactionNonWolfRole: player("wolfFactionNonWolfRole", {
      originalRole: "seer",
      role: "seer",
      faction: "wolves",
    }),
  },
} as unknown as GameState;

const wolfEvent = (id: number) =>
  ({
    id,
    kind: "chat.message",
    scope: "faction",
    scopeId: "wolves",
    createdAt: 0,
    payload: {},
  }) as unknown as GameEvent;

test.each([
  ["a starting wolf reads the whole wolf history", "startingWolf", 1, true],
  ["a dead wolf still reads wolf chat", "deadWolf", 99, true],
  ["a villager never reads wolf chat", "villager", 1, false],
  [
    "a wolf-faction player whose role is not a wolf-chat role reads nothing",
    "wolfFactionNonWolfRole",
    1,
    false,
  ],
  ["a converted player cannot read before their conversion", "converted", 49, false],
  ["a converted player reads from their conversion onward", "converted", 50, true],
])("%s", (_name, viewer, eventId, expected) => {
  expect(canViewEvent(wolfEvent(eventId), viewer as UserId, state)).toBe(expected);
});

test("a converted player with no conversion marker is denied rather than trusted", () => {
  // The marker is written when the conversion event is persisted. If it is
  // missing the player must see nothing, not everything.
  expect(canViewEvent(wolfEvent(1), "convertedWithoutMarker" as UserId, state)).toBe(false);
  expect(canViewEvent(wolfEvent(9999), "convertedWithoutMarker" as UserId, state)).toBe(false);
});
