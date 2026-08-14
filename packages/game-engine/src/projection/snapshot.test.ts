import { describe, expect, test } from "bun:test";
import type { GameEvent, UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { filterVisibleEvents } from "./events.ts";
import { canViewEvent } from "./permissions.ts";
import { projectSnapshot } from "./snapshot.ts";

const id = (value: string) => value as UserId;

function makeState(): GameState {
  const players: Record<string, PlayerState> = {};
  for (const [userId, role, status] of [
    ["wolf", "werewolf", "alive"],
    ["seer", "seer", "alive"],
    ["dead-wolf", "werewolf", "dead"],
  ] as const) {
    players[userId] = {
      id: id(userId),
      displayName: userId,
      status,
      originalRole: role,
      role,
      faction: role === "werewolf" ? "wolves" : "village",
      roleState: {},
      phaseState: { phaseId: 1 as never },
    };
  }
  return {
    id: "game" as GameState["id"],
    name: "Game",
    ownerUserId: id("seer"),
    status: "running",
    day: 1,
    phase: {
      id: 1 as never,
      type: "night",
      startedAt: 0,
      endsAt: 10,
    },
    players,
    settings: { discussionDurationMs: 1000, votingDurationMs: 1000, nightDurationMs: 1000 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  };
}

const event = (id: number, scope: GameEvent["scope"], kind: GameEvent["kind"], scopeId?: string) =>
  ({
    id: id as GameEvent["id"],
    kind,
    scope,
    ...(scopeId ? { scopeId } : {}),
    createdAt: 0,
    payload:
      kind === "seer.result" ? { targetId: "wolf" as UserId, role: "werewolf" as const } : {},
  }) as GameEvent;

describe("viewer projection security", () => {
  test("living roles stay hidden, dead roles are public, and a member sees only their own role", () => {
    const state = makeState();
    const snapshot = projectSnapshot(state, { userId: id("seer"), cursor: 4, serverNow: 5 });
    expect(snapshot.game.ownerUserId).toBe(id("seer"));
    expect(snapshot.me?.role).toBe("seer");
    expect(snapshot.players.find((player) => player.userId === id("wolf"))).not.toHaveProperty(
      "revealedRole",
    );
    expect(snapshot.players.find((player) => player.userId === id("dead-wolf"))).toHaveProperty(
      "revealedRole",
      "werewolf",
    );
  });

  test("a non-member has no me and no living roles", () => {
    const snapshot = projectSnapshot(makeState(), {
      userId: id("spectator"),
      cursor: 0,
      serverNow: 0,
    });
    expect(snapshot.me).toBeUndefined();
    expect(
      snapshot.players.every((player) => !player.revealedRole || player.status === "dead"),
    ).toBe(true);
  });

  test("event scopes protect private, wolf, and server events", () => {
    const state = makeState();
    const privateEvent = event(1, "player", "seer.result", "seer");
    const wolfEvent = event(2, "faction", "chat.message", "wolves");
    const oldWolfEvent = event(3, "faction", "chat.message", "wolves");
    state.players[id("seer")]!.wolfSinceEventId = 4 as GameEvent["id"];
    expect(canViewEvent(privateEvent, id("seer"), state)).toBe(true);
    expect(canViewEvent(privateEvent, id("wolf"), state)).toBe(false);
    expect(canViewEvent(wolfEvent, id("seer"), state)).toBe(false);
    expect(canViewEvent(oldWolfEvent, id("dead-wolf"), state)).toBe(true);
    expect(filterVisibleEvents([privateEvent, wolfEvent], id("spectator"), state)).toEqual([]);
    expect(canViewEvent(event(5, "server", "audit.vote"), id("wolf"), state)).toBe(false);
  });

  test("converted wolves only see events from conversion onward", () => {
    const state = makeState();
    state.players[id("seer")]!.faction = "wolves";
    state.players[id("seer")]!.wolfSinceEventId = 10 as GameEvent["id"];
    expect(canViewEvent(event(9, "faction", "chat.message", "wolves"), id("seer"), state)).toBe(
      false,
    );
    expect(canViewEvent(event(10, "faction", "chat.message", "wolves"), id("seer"), state)).toBe(
      true,
    );
  });
});
