import { describe, expect, test } from "bun:test";
import type { GameplayCommand, UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { applyCommand } from "./apply.ts";
import { validateCommand } from "./validate.ts";

const uid = (id: string) => id as PlayerState["id"];

function state(
  phase: "discussion" | "voting" | "night" = "discussion",
  phaseId = 1,
  dead: string[] = [],
  endsAt = 100,
  roles: PlayerState["role"][] = ["villager", "villager", "villager"],
): GameState {
  const players = Object.fromEntries(
    ["p0", "p1", "p2"].map((id, index) => {
      const playerId = uid(id);
      const role = roles[index] ?? "villager";
      return [
        playerId,
        {
          id: playerId,
          status: dead.includes(id) ? "dead" : "alive",
          originalRole: role,
          role,
          faction: role === "werewolf" ? "wolves" : "village",
          roleState: {},
          phaseState: { phaseId },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    ownerUserId: uid("p0"),
    status: "running",
    day: 1,
    phase: { id: phaseId as never, type: phase, startedAt: 0, endsAt },
    players,
    settings: { discussionDurationMs: 100, votingDurationMs: 100, nightDurationMs: 100 },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function ready(ready: boolean, phaseId = 1, commandId = "c1"): GameplayCommand {
  return {
    commandId,
    phaseId: phaseId as never,
    type: "phase.ready",
    payload: { ready },
  };
}

/** Applies a command that must succeed and returns the state with the patch applied. */
function apply(game: GameState, actorId: string, command: GameplayCommand): GameState {
  const result = applyCommand(game, actorId as UserId, command, { now: 1 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  const patch = result.transition.playerPatches[0]!;
  return {
    ...game,
    players: {
      ...game.players,
      [patch.playerId]: { ...game.players[patch.playerId]!, ...patch.changes },
    },
  };
}

describe("phase.ready validation", () => {
  test.each(["discussion", "voting", "night"] as const)(
    "a living player may ready during %s",
    (phase) => {
      const game = state(phase);
      const result = validateCommand(game, uid("p0"), ready(true), { now: 1 });
      expect(result).toBeNull();
    },
  );

  test("a dead player readying is rejected with NOT_ALIVE", () => {
    const game = state("discussion", 1, ["p0"]);
    const result = validateCommand(game, uid("p0"), ready(true), { now: 1 });
    expect(result).toEqual({ code: "NOT_ALIVE" });
  });

  test("a ready for a stale phaseId is rejected with PHASE_MISMATCH", () => {
    const game = state("discussion", 1);
    const result = validateCommand(game, uid("p0"), ready(true, 2), { now: 1 });
    expect(result).toEqual({ code: "PHASE_MISMATCH" });
  });

  test("a ready after phase.endsAt is rejected with PHASE_CLOSED", () => {
    const game = state("discussion", 1, [], 10);
    const result = validateCommand(game, uid("p0"), ready(true), { now: 10 });
    expect(result).toEqual({ code: "PHASE_CLOSED" });
  });
});

describe("phase.ready storage", () => {
  test("readying produces no events at all", () => {
    const game = state("discussion");
    const result = applyCommand(game, uid("p0"), ready(true), { now: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.transition.events).toEqual([]);
    expect(result.transition.ephemeral).toEqual([]);
  });

  test("setting a vote preserves ready and actions", () => {
    let game = state("voting");
    game = apply(game, "p0", ready(true));
    game = apply(game, "p0", {
      commandId: "v1",
      phaseId: 1 as never,
      type: "vote.set",
      payload: { targetId: uid("p1") },
    });
    expect(game.players[uid("p0")]!.phaseState).toEqual({
      phaseId: 1 as never,
      ready: true,
      vote: { type: "player", targetId: uid("p1") },
    });
  });

  test("setting or clearing a night action preserves ready and vote", () => {
    let game = state("night", 1, [], 100, ["werewolf", "villager", "villager"]);
    game = apply(game, "p0", ready(true));
    game = apply(game, "p0", {
      commandId: "n1",
      phaseId: 1 as never,
      type: "night.action.set",
      payload: { action: "wolf.attack", targetId: uid("p1") },
    });
    expect(game.players[uid("p0")]!.phaseState).toEqual({
      phaseId: 1 as never,
      ready: true,
      actions: { "wolf.attack": { targetId: uid("p1") } },
    });
    game = apply(game, "p0", {
      commandId: "n2",
      phaseId: 1 as never,
      type: "night.action.clear",
      payload: { action: "wolf.attack" },
    });
    expect(game.players[uid("p0")]!.phaseState).toEqual({
      phaseId: 1 as never,
      ready: true,
      actions: {},
    });
  });

  test("setting ready preserves vote and actions", () => {
    let game = state("night", 1, [], 100, ["werewolf", "villager", "villager"]);
    game = apply(game, "p0", {
      commandId: "n1",
      phaseId: 1 as never,
      type: "night.action.set",
      payload: { action: "wolf.attack", targetId: uid("p1") },
    });
    game = apply(game, "p0", ready(true));
    expect(game.players[uid("p0")]!.phaseState).toEqual({
      phaseId: 1 as never,
      ready: true,
      actions: { "wolf.attack": { targetId: uid("p1") } },
    });
  });
});
