import { describe, expect, test } from "bun:test";
import type { GameplayCommand, UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { applyCommand } from "./apply.ts";

const uid = (id: string) => id as PlayerState["id"];

function state(
  phase: "discussion" | "voting" | "night" = "discussion",
  dead: string[] = [],
  startedAt = 0,
  duration = 100,
): GameState {
  const players = Object.fromEntries(
    ["p0", "p1", "p2"].map((id) => {
      const playerId = uid(id);
      return [
        playerId,
        {
          id: playerId,
          status: dead.includes(id) ? "dead" : "alive",
          originalRole: "villager",
          role: "villager",
          faction: "village",
          roleState: {},
          phaseState: { phaseId: 1 },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    ownerUserId: uid("p0"),
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: phase, startedAt, endsAt: startedAt + duration },
    players,
    settings: {
      discussionDurationMs: duration,
      votingDurationMs: duration,
      nightDurationMs: duration,
    },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function ready(ready: boolean, commandId = "c1"): GameplayCommand {
  return {
    commandId,
    phaseId: 1 as never,
    type: "phase.ready",
    payload: { ready },
  };
}

/** Applies a command that must succeed and returns the state with the patch applied. */
function apply(game: GameState, actorId: string, command: GameplayCommand, now: number): GameState {
  const result = applyCommand(game, actorId as UserId, command, { now });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  const patch = result.transition.playerPatches[0]!;
  return {
    ...game,
    ...(result.transition.gamePatch ?? {}),
    players: {
      ...game.players,
      [patch.playerId]: { ...game.players[patch.playerId]!, ...patch.changes },
    },
  };
}

function applyAndPatch(game: GameState, actorId: string, command: GameplayCommand, now: number) {
  const result = applyCommand(game, actorId as UserId, command, { now });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  return result.transition;
}

describe("phase.ready early completion", () => {
  test("the last living player readying after the floor patches endsAt to now", () => {
    // startedAt 0, duration 100 -> full 100, floor 40. now 60 is past the floor.
    let game = state("discussion");
    game = apply(game, "p0", ready(true), 60);
    game = apply(game, "p1", ready(true), 60);
    const transition = applyAndPatch(game, "p2", ready(true), 60);
    expect(transition.gamePatch?.phase?.endsAt).toBe(60);
  });

  test("the last living player readying before the floor patches endsAt to the floor, not now", () => {
    // startedAt 0, duration 100 -> full 100, floor 40. now 10 is before the floor.
    let game = state("discussion");
    game = apply(game, "p0", ready(true), 10);
    game = apply(game, "p1", ready(true), 10);
    const transition = applyAndPatch(game, "p2", ready(true), 10);
    expect(transition.gamePatch?.phase?.endsAt).toBe(40);
  });

  test("with one living player not ready, endsAt stays at the full deadline", () => {
    let game = state("discussion");
    game = apply(game, "p0", ready(true), 60);
    game = apply(game, "p1", ready(true), 60);
    const transition = applyAndPatch(game, "p2", ready(false), 60);
    expect(transition.gamePatch?.phase?.endsAt).toBe(100);
  });

  test("un-readying after the deadline was shortened restores the full deadline", () => {
    // Duration 100, so the floor is at startedAt + 40. Everyone readies at
    // now=20; because 20 < 40, endsAt becomes 40, not 20. A player un-readies
    // at now=30, still before the shortened deadline of 40, so the command is
    // legal and PHASE_CLOSED does not fire. endsAt must go back to the full 100.
    let game = state("discussion");
    game = apply(game, "p0", ready(true), 20);
    game = apply(game, "p1", ready(true), 20);
    game = apply(game, "p2", ready(true), 20);
    expect(game.phase!.endsAt).toBe(40);
    const transition = applyAndPatch(game, "p2", ready(false), 30);
    expect(transition.gamePatch?.phase?.endsAt).toBe(100);
  });

  test("a ready or un-ready after endsAt was shortened to now is rejected with PHASE_CLOSED", () => {
    // Everyone readies after the floor at now=50, shortening endsAt to 50.
    // A later ready or un-ready at now=60 is past the shortened deadline, so
    // the phase is closed and the command is rejected.
    let game = state("discussion");
    game = apply(game, "p0", ready(true), 50);
    game = apply(game, "p1", ready(true), 50);
    game = apply(game, "p2", ready(true), 50);
    expect(game.phase!.endsAt).toBe(50);
    const readyResult = applyCommand(game, uid("p0"), ready(true, "later-ready"), { now: 60 });
    expect(readyResult).toEqual({ ok: false, error: { code: "PHASE_CLOSED" } });
    const unreadyResult = applyCommand(game, uid("p0"), ready(false, "later-unready"), { now: 60 });
    expect(unreadyResult).toEqual({ ok: false, error: { code: "PHASE_CLOSED" } });
  });

  test("endsAt never exceeds the full deadline", () => {
    // Everyone readies at now=90, just before the full deadline of 100. The
    // shortened endsAt must clamp to the full deadline, never exceed it.
    let game = state("discussion");
    game = apply(game, "p0", ready(true), 90);
    game = apply(game, "p1", ready(true), 90);
    const transition = applyAndPatch(game, "p2", ready(true), 90);
    expect(transition.gamePatch?.phase?.endsAt).toBe(90);
    expect(transition.gamePatch!.phase!.endsAt).toBeLessThanOrEqual(100);
  });

  test("dead players are not counted: every living player ready completes the phase", () => {
    // p2 is dead and never readies; p0 and p1 are the only living players.
    let game = state("discussion", ["p2"]);
    game = apply(game, "p0", ready(true), 60);
    const transition = applyAndPatch(game, "p1", ready(true), 60);
    expect(transition.gamePatch?.phase?.endsAt).toBe(60);
  });
});
