import { describe, expect, test } from "bun:test";
import type { GameState, PlayerState } from "../state.ts";
import { checkVictory } from "./victory.ts";

function player(
  id: string,
  role: PlayerState["role"],
  overrides: Partial<PlayerState> = {},
): PlayerState {
  return {
    id: id as PlayerState["id"],
    status: "alive",
    originalRole: role,
    role,
    faction:
      role === "werewolf" || role === "cursed"
        ? "wolves"
        : role === "serial_killer"
          ? "serial_killer"
          : role === "veteran"
            ? "veteran"
            : "village",
    roleState: {},
    phaseState: { phaseId: 1 as never },
    ...overrides,
  };
}
function game(players: PlayerState[]): GameState {
  return {
    id: "g" as GameState["id"],
    ownerUserId: players[0]!.id,
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: "voting", startedAt: 0, endsAt: 100 },
    players: Object.fromEntries(players.map((p) => [p.id, p])),
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

describe("victory checks", () => {
  test("no wolves left means the village wins", () => {
    const state = game([
      player("p0", "villager"),
      player("p1", "villager"),
      player("p2", "werewolf", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["village"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "wolves_eliminated",
    });
  });

  test("a lone serial killer wins", () => {
    const state = game([player("p0", "serial_killer")]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["serial_killer"],
      winningPlayers: ["p0" as PlayerState["id"]],
      reason: "serial_killer_survives",
    });
  });

  test("a lone serial killer wins with dead faction members included", () => {
    const state = game([
      player("p0", "serial_killer", { status: "dead" }),
      player("p1", "serial_killer"),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["serial_killer"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "serial_killer_survives",
    });
  });

  test("wolves win when every living player is a wolf", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "werewolf"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });

  test("wolves and a serial killer alive together is not a win for anybody", () => {
    const state = game([player("p0", "werewolf"), player("p1", "serial_killer")]);
    expect(checkVictory(state)).toBeNull();
  });

  test("two wolves against one villager is not a win", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "werewolf"),
      player("p2", "villager"),
    ]);
    expect(checkVictory(state)).toBeNull();
  });

  test("wolves fewer than villagers means the game continues", () => {
    const state = game([
      player("p0", "werewolf"),
      player("p1", "villager"),
      player("p2", "villager"),
    ]);
    expect(checkVictory(state)).toBeNull();
  });

  test("dead players on the winning side appear in winningPlayers", () => {
    const state = game([
      player("p0", "cursed", { status: "dead" }),
      player("p1", "werewolf"),
      player("p2", "villager", { status: "dead" }),
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: ["p0" as PlayerState["id"], "p1" as PlayerState["id"]],
      reason: "village_eliminated",
    });
  });
});
