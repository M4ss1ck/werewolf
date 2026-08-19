import { describe, expect, test } from "bun:test";
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
      channelSince: { wolves: 50 as GameEvent["id"] },
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
    cultLeader: player("cultLeader", {
      originalRole: "cult_leader",
      role: "cult_leader",
      faction: "cult",
    }),
    convertedCultist: player("convertedCultist", {
      originalRole: "villager",
      role: "cultist",
      faction: "cult",
      channelSince: { cult: 50 as GameEvent["id"] },
    }),
    convertedCultistWithoutMarker: player("convertedCultistWithoutMarker", {
      originalRole: "villager",
      role: "cultist",
      faction: "cult",
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

const graveEvent = (id: number) =>
  ({
    id,
    kind: "chat.message",
    scope: "faction",
    scopeId: "grave",
    createdAt: 0,
    payload: {},
  }) as unknown as GameEvent;

const cultEvent = (id: number) =>
  ({
    id,
    kind: "chat.message",
    scope: "faction",
    scopeId: "cult",
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

describe("cult chat visibility", () => {
  test("the cult leader reads the whole cult history", () => {
    expect(canViewEvent(cultEvent(1), "cultLeader" as UserId, state)).toBe(true);
    expect(canViewEvent(cultEvent(9999), "cultLeader" as UserId, state)).toBe(true);
  });

  test("a convert reads only from their marker onward, and nothing before", () => {
    expect(canViewEvent(cultEvent(49), "convertedCultist" as UserId, state)).toBe(false);
    expect(canViewEvent(cultEvent(50), "convertedCultist" as UserId, state)).toBe(true);
  });

  test("a convert with no marker sees nothing (fail closed)", () => {
    expect(canViewEvent(cultEvent(1), "convertedCultistWithoutMarker" as UserId, state)).toBe(
      false,
    );
    expect(canViewEvent(cultEvent(9999), "convertedCultistWithoutMarker" as UserId, state)).toBe(
      false,
    );
  });

  test("nobody outside CULT_CHAT_ROLES sees cult events", () => {
    // A living villager and a wolf both see nothing.
    expect(canViewEvent(cultEvent(1), "villager" as UserId, state)).toBe(false);
    expect(canViewEvent(cultEvent(1), "startingWolf" as UserId, state)).toBe(false);
    // A wolf-faction player whose role is not a cult-chat role sees nothing.
    expect(canViewEvent(cultEvent(1), "wolfFactionNonWolfRole" as UserId, state)).toBe(false);
  });
});

describe("grave channel visibility", () => {
  const deadVillager = player("deadVillager", {
    originalRole: "villager",
    role: "villager",
    faction: "village",
    status: "dead",
  });
  const graveState = {
    ...state,
    players: { ...state.players, deadVillager },
  } as unknown as GameState;

  test("a living player cannot see a grave-channel event", () => {
    expect(canViewEvent(graveEvent(1), "villager" as UserId, graveState)).toBe(false);
    expect(canViewEvent(graveEvent(1), "startingWolf" as UserId, graveState)).toBe(false);
  });

  test("a dead player sees grave events, including ones older than any marker and their own death", () => {
    // The dead see the whole graveyard history, no since-marker applies.
    expect(canViewEvent(graveEvent(1), "deadWolf" as UserId, graveState)).toBe(true);
    expect(canViewEvent(graveEvent(1), "deadVillager" as UserId, graveState)).toBe(true);
  });

  test("a spectator cannot see grave events", () => {
    const spectator = player("spectator", { status: "spectator" });
    const withSpectator = {
      ...graveState,
      players: { ...graveState.players, spectator },
    } as unknown as GameState;
    expect(canViewEvent(graveEvent(1), "spectator" as UserId, withSpectator)).toBe(false);
  });
});
