import { describe, expect, test } from "bun:test";
import type { GameEvent, UserId } from "@werewolf/protocol";
import { getAvailableActions } from "../projection/available-actions.ts";
import { canViewEvent } from "../projection/permissions.ts";
import type { GameState, PlayerPatch, PlayerState } from "../state.ts";
import { action, deadPlayerIds, id, makeState, resolve } from "./night.test.ts";
import { checkVictory } from "./victory.ts";

const convert = (target: string) => ({ "cult.convert": { targetId: id(target) } });
const convertedPatch = (playerId: string): PlayerPatch => ({
  playerId: id(playerId),
  changes: { role: "cultist", faction: "cult" },
});

describe("cult conversion", () => {
  test("the leader converts a villager into a cultist", () => {
    const transition = resolve(makeState(["cult_leader", "villager"], { p0: convert("p1") }));
    expect(transition.playerPatches).toContainEqual(convertedPatch("p1"));
    expect(transition.events).toContainEqual({
      kind: "player.converted",
      scope: "player",
      scopeId: "p1",
      payload: { role: "cultist", faction: "cult", cause: "cult" },
    });
    expect(transition.events).toContainEqual({
      kind: "cult.member_joined",
      scope: "faction",
      scopeId: "cult",
      payload: { playerId: id("p1") },
    });
  });

  test("a wolf, a serial killer and a hunter are immune to conversion", () => {
    for (const role of ["werewolf", "serial_killer", "hunter"] as const) {
      const transition = resolve(makeState(["cult_leader", role], { p0: convert("p1") }));
      expect(transition.playerPatches).not.toContainEqual(convertedPatch("p1"));
    }
  });

  test("the veteran IS converted", () => {
    const transition = resolve(makeState(["cult_leader", "veteran"], { p0: convert("p1") }));
    expect(transition.playerPatches).toContainEqual(convertedPatch("p1"));
  });

  test("a target killed the same night is not converted", () => {
    const transition = resolve(
      makeState(["cult_leader", "werewolf", "villager"], {
        p0: convert("p2"),
        p1: action("p2"),
      }),
    );
    // The leader travels to the target's house, so the pack attack on that
    // house kills both the leader and the target.
    expect(deadPlayerIds(transition)).toEqual(["p0", "p2"]);
    expect(transition.playerPatches).not.toContainEqual(convertedPatch("p2"));
  });

  test("a target shielded by the priest is not converted", () => {
    const transition = resolve(
      makeState(["cult_leader", "priest", "villager"], {
        p0: convert("p2"),
        p1: { "priest.protect": { targetId: id("p2") } },
      }),
    );
    expect(transition.playerPatches).not.toContainEqual(convertedPatch("p2"));
  });

  test("a guardian's protegee IS converted (substitution does not apply)", () => {
    const transition = resolve(
      makeState(["cult_leader", "guardian", "villager"], {
        p0: convert("p2"),
        p1: { "guardian.bond": { targetId: id("p2") } },
      }),
    );
    expect(transition.playerPatches).toContainEqual(convertedPatch("p2"));
  });

  test("the conversion lands even though the leader died that night", () => {
    // The leader converts the Cursed and the pack attacks the Cursed's house.
    // The leader travels there and dies; the Cursed is turned by the pack
    // (not killed), and the cult conversion still lands on top of it.
    const transition = resolve(
      makeState(["cult_leader", "werewolf", "cursed"], {
        p0: convert("p2"),
        p1: action("p2"),
      }),
    );
    expect(deadPlayerIds(transition)).toEqual(["p0"]);
    expect(transition.playerPatches).toContainEqual(convertedPatch("p2"));
  });

  test("the leader travels and dies when the pack attacks the house they visited", () => {
    const transition = resolve(
      makeState(["cult_leader", "werewolf", "villager"], {
        p0: convert("p2"),
        p1: action("p2"),
      }),
    );
    // The leader walked to p2's house, so the pack attack on that house kills
    // both the leader and the owner.
    expect(deadPlayerIds(transition)).toEqual(["p0", "p2"]);
  });

  test("with the leader dead no conversion happens, but cultists remain and can still win", () => {
    const state = makeState(["cult_leader", "cultist", "villager"], { p0: convert("p2") });
    state.players[id("p0")]!.status = "dead";
    const transition = resolve(state);
    expect(transition.playerPatches).not.toContainEqual(convertedPatch("p2"));

    // Without a living leader, the converted cultist has no contesting role and
    // cannot win by itself.
    const victory = victoryGame([
      { id: "p0", role: "cult_leader", faction: "cult", status: "dead" },
      { id: "p1", role: "cultist", faction: "cult", status: "alive" },
    ]);
    expect(checkVictory(victory)).toEqual({
      winningFactions: [],
      winningPlayers: [],
      reason: "stalemate",
    });
  });

  test("a cultist has no cult.convert action", () => {
    const game = makeState(["cultist", "villager"]);
    expect(getAvailableActions(game, id("p0"))).toEqual([]);
  });
});

describe("cult chat visibility", () => {
  const cultEvent = (eventId: number) =>
    ({
      id: eventId,
      kind: "chat.message",
      scope: "faction",
      scopeId: "cult",
      createdAt: 0,
      payload: {},
    }) as unknown as GameEvent;

  const chatState = {
    players: {
      leader: {
        id: id("leader"),
        status: "alive",
        originalRole: "cult_leader",
        role: "cult_leader",
        faction: "cult",
        roleState: {},
        phaseState: { phaseId: 1 as never },
      },
      convert: {
        id: id("convert"),
        status: "alive",
        originalRole: "villager",
        role: "cultist",
        faction: "cult",
        channelSince: { cult: 50 as GameEvent["id"] },
        roleState: {},
        phaseState: { phaseId: 1 as never },
      },
      noMarker: {
        id: id("noMarker"),
        status: "alive",
        originalRole: "villager",
        role: "cultist",
        faction: "cult",
        roleState: {},
        phaseState: { phaseId: 1 as never },
      },
      villager: {
        id: id("villager"),
        status: "alive",
        originalRole: "villager",
        role: "villager",
        faction: "village",
        roleState: {},
        phaseState: { phaseId: 1 as never },
      },
      wolf: {
        id: id("wolf"),
        status: "alive",
        originalRole: "werewolf",
        role: "werewolf",
        faction: "wolves",
        roleState: {},
        phaseState: { phaseId: 1 as never },
      },
    },
  } as unknown as GameState;

  test("the leader reads the whole cult history", () => {
    expect(canViewEvent(cultEvent(1), "leader" as UserId, chatState)).toBe(true);
    expect(canViewEvent(cultEvent(9999), "leader" as UserId, chatState)).toBe(true);
  });

  test("a convert reads only from their marker onward, and nothing before", () => {
    expect(canViewEvent(cultEvent(49), "convert" as UserId, chatState)).toBe(false);
    expect(canViewEvent(cultEvent(50), "convert" as UserId, chatState)).toBe(true);
  });

  test("a convert with no marker sees nothing (fail closed)", () => {
    expect(canViewEvent(cultEvent(1), "noMarker" as UserId, chatState)).toBe(false);
    expect(canViewEvent(cultEvent(9999), "noMarker" as UserId, chatState)).toBe(false);
  });

  test("nobody outside CULT_CHAT_ROLES sees cult events", () => {
    expect(canViewEvent(cultEvent(1), "villager" as UserId, chatState)).toBe(false);
    expect(canViewEvent(cultEvent(1), "wolf" as UserId, chatState)).toBe(false);
  });
});

describe("cult victory", () => {
  test("all living players cult is a cult win", () => {
    const state = victoryGame([
      { id: "p0", role: "cult_leader", faction: "cult", status: "alive" },
      { id: "p1", role: "cultist", faction: "cult", status: "alive" },
    ]);
    expect(checkVictory(state)).toEqual({
      winningFactions: ["cult"],
      winningPlayers: [id("p0"), id("p1")],
      reason: "cult_survives",
    });
  });

  test("one living villager plus living cultists is NOT a village win", () => {
    const state = victoryGame([
      { id: "p0", role: "villager", faction: "village", status: "alive" },
      { id: "p1", role: "cultist", faction: "cult", status: "alive" },
      { id: "p2", role: "cultist", faction: "cult", status: "alive" },
      { id: "p3", role: "cultist", faction: "cult", status: "alive" },
    ]);
    expect(checkVictory(state)).toMatchObject({
      winningFactions: ["cult"],
      reason: "cult_survives",
    });
  });

  test("a cult and wolves both alive is not a win for anyone yet", () => {
    const state = victoryGame([
      { id: "p0", role: "cult_leader", faction: "cult", status: "alive" },
      { id: "p1", role: "werewolf", faction: "wolves", status: "alive" },
    ]);
    expect(checkVictory(state)).toBeNull();
  });

  test("the exhaustive sweep over five factions names no winning faction without a living member", () => {
    for (let v = 0; v <= 3; v += 1) {
      for (let w = 0; w <= 3; w += 1) {
        for (let vet = 0; vet <= 3; vet += 1) {
          for (let sk = 0; sk <= 3; sk += 1) {
            for (let c = 0; c <= 3; c += 1) {
              const players: { id: string; faction: string; status: string }[] = [];
              let index = 0;
              for (const [faction, count] of [
                ["village", v],
                ["wolves", w],
                ["veteran", vet],
                ["serial_killer", sk],
                ["cult", c],
              ] as const) {
                for (let i = 0; i < count; i += 1) {
                  players.push({ id: `p${index++}`, faction, status: "alive" });
                }
              }
              const result = checkVictory(victoryGame(players));
              if (result && result.winningFactions.length > 0) {
                for (const faction of result.winningFactions) {
                  expect(
                    players.some((p) => p.faction === faction),
                    `faction ${faction} must have a living member for v=${v} w=${w} vet=${vet} sk=${sk} c=${c}`,
                  ).toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });
});

function victoryGame(
  players: { id: string; role?: PlayerState["role"]; faction: string; status: string }[],
): GameState {
  return {
    id: id("g") as unknown as GameState["id"],
    ownerUserId: id("p0"),
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: "voting", startedAt: 0, endsAt: 100 },
    players: Object.fromEntries(
      players.map((p) => [
        p.id,
        {
          id: id(p.id),
          status: p.status,
          originalRole: p.role ?? null,
          role: p.role ?? null,
          faction: p.faction,
          roleState: {},
          phaseState: { phaseId: 1 as never },
        } as PlayerState,
      ]),
    ),
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  } as unknown as GameState;
}
