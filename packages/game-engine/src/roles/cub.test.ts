import { describe, expect, test } from "bun:test";
import type { GameEvent } from "@werewolf/protocol";
import { WOLF_ROLE_IDS } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import { canViewEvent } from "../projection/permissions.ts";
import { resolveNight } from "../resolution/night.ts";
import { checkVictory } from "../resolution/victory.ts";
import { SeededRng } from "../rng/rng.ts";
import type { GameState, PlayerState } from "../state.ts";
import { WOLF_CHAT_ROLES } from "./registry.ts";

const id = (value: string) => value as PlayerState["id"];

function makeState(
  roles: PlayerState["role"][],
  actions: Record<string, Record<string, unknown>> = {},
  phaseId = 1,
): GameState {
  const players = Object.fromEntries(
    roles.map((role, index) => {
      const playerId = id(`p${index}`);
      return [
        playerId,
        {
          id: playerId,
          status: "alive",
          originalRole: role,
          role,
          faction:
            role === "werewolf" || role === "alpha_wolf" || role === "cub"
              ? "wolves"
              : role === "serial_killer"
                ? "serial_killer"
                : role === "veteran"
                  ? "veteran"
                  : "village",
          roleState: {},
          phaseState: { phaseId, actions: actions[`p${index}`] },
        },
      ];
    }),
  );
  return {
    id: id("g") as unknown as GameState["id"],
    ownerUserId: id("p0"),
    status: "running",
    day: 1,
    phase: { id: phaseId as never, type: "night", startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 10, votingDurationMs: 10, nightDurationMs: 10 },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function resolve(state: GameState, seed = "seed") {
  const result = resolveNight(state, { now: 100, rng: new SeededRng(seed) });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.transition;
}

function deadPlayerIds(transition: ReturnType<typeof resolve>): string[] {
  return transition.playerPatches
    .filter((patch) => patch.changes.status === "dead")
    .map((patch) => String(patch.playerId))
    .sort();
}

describe("the Cub", () => {
  test("is in WOLF_CHAT_ROLES and may read and write the wolves channel", () => {
    expect(WOLF_CHAT_ROLES.has("cub")).toBe(true);
    const state = makeState(["cub", "villager"]);
    const write = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "chat.send",
        payload: { channel: "wolves", text: "hello" },
      },
      { now: 1 },
    );
    expect(write).toBeNull();
    const event: GameEvent = {
      id: 1 as GameEvent["id"],
      kind: "wolves.member_joined",
      scope: "faction",
      scopeId: "wolves",
      createdAt: 0,
      payload: { playerId: id("p1") },
    };
    expect(canViewEvent(event, id("p0"), state)).toBe(true);
  });

  test("is offered wolf.attack and its vote counts in the wolf ballot", () => {
    const state = makeState(["cub", "werewolf", "villager", "villager"]);
    expect(getAvailableActions(state, id("p0"))).toContainEqual({
      id: "wolf.attack",
      type: "target",
      targets: [
        { userId: id("p1"), enabled: false },
        { userId: id("p2"), enabled: true },
        { userId: id("p3"), enabled: true },
      ],
    });
    // The cub votes for p2, the werewolf for p3: if the cub's vote counted the
    // ballot ties and nobody is attacked; if it did not, p3 would die.
    const night = makeState(["cub", "werewolf", "villager", "villager"], {
      p0: { "wolf.attack": { targetId: id("p2") } },
      p1: { "wolf.attack": { targetId: id("p3") } },
    });
    const transition = resolve(night);
    expect(deadPlayerIds(transition)).toEqual([]);
    const audit = transition.events.find((candidate) => candidate.kind === "audit.night");
    expect(audit?.payload).toMatchObject({
      wolfVotes: [
        { playerId: id("p0"), targetId: id("p2") },
        { playerId: id("p1"), targetId: id("p3") },
      ],
    });
  });

  test("is immune to the pack's own attack, like any wolf", () => {
    const night = makeState(["werewolf", "werewolf", "cub", "villager"], {
      p0: { "wolf.attack": { targetId: id("p2") } },
      p1: { "wolf.attack": { targetId: id("p2") } },
    });
    const transition = resolve(night);
    expect(deadPlayerIds(transition)).toEqual([]);
  });

  test("a game whose only living players are wolves including a cub is a wolves win", () => {
    const state = makeState(["cub", "werewolf", "villager"]);
    state.players[id("p2")]!.status = "dead";
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: [id("p0"), id("p1")],
      reason: "village_eliminated",
    });
  });

  test("is revealed as a wolf: it is in WOLF_ROLE_IDS", () => {
    expect(WOLF_ROLE_IDS).toContain("cub");
  });
});
