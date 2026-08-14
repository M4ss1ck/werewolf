import { describe, expect, test } from "bun:test";
import type { GameplayCommand } from "@werewolf/protocol";
import { applyCommand } from "../commands/apply.ts";
import type { GameState, PlayerState } from "../state.ts";
import { getAvailableActions } from "./available-actions.ts";

const uid = (id: string) => id as PlayerState["id"];

function state(
  roles: PlayerState["role"][],
  phase: "discussion" | "voting" | "night" = "night",
  dead: string[] = [],
): GameState {
  const players = Object.fromEntries(
    roles.map((role, index) => {
      const id = uid(`p${index}`);
      return [
        id,
        {
          id,
          status: dead.includes(id) ? "dead" : "alive",
          originalRole: role,
          role,
          faction: role === "werewolf" ? "wolves" : "village",
          roleState: {},
          phaseState: { phaseId: 1 },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    status: "running",
    day: 1,
    phase: { id: 1 as never, type: phase, startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

/** Applies a command that must succeed and returns the state with the patch applied. */
function apply(game: GameState, actorId: string, command: GameplayCommand): GameState {
  const result = applyCommand(game, uid(actorId), command, { now: 1 });
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

describe("available actions projection", () => {
  test("a wolf may attack living non-wolves, with wolves and the dead disabled", () => {
    const game = state(["werewolf", "villager", "werewolf", "villager"], "night", ["p3"]);
    expect(getAvailableActions(game, uid("p0"))).toEqual([
      {
        id: "wolf.attack",
        type: "target",
        targets: [
          { userId: uid("p1"), enabled: true },
          { userId: uid("p2"), enabled: false },
          { userId: uid("p3"), enabled: false },
        ],
      },
    ]);
  });

  test("a seer may inspect any living player but herself", () => {
    const game = state(["seer", "villager", "villager"], "night", ["p2"]);
    expect(getAvailableActions(game, uid("p0"))).toEqual([
      {
        id: "seer.inspect",
        type: "target",
        targets: [
          { userId: uid("p1"), enabled: true },
          { userId: uid("p2"), enabled: false },
        ],
      },
    ]);
  });

  test("a harlot may visit any living player but herself, or stay home", () => {
    const game = state(["harlot", "villager", "villager"]);
    expect(getAvailableActions(game, uid("p0"))).toEqual([
      {
        id: "harlot.visit",
        type: "target",
        targets: [
          { userId: uid("p1"), enabled: true },
          { userId: uid("p2"), enabled: true },
        ],
      },
      { id: "harlot.stay", type: "choice" },
    ]);
  });

  test("a plain villager has no night actions", () => {
    const game = state(["villager", "villager"]);
    expect(getAvailableActions(game, uid("p0"))).toEqual([]);
  });

  test("no night actions are offered outside night or to the dead", () => {
    const discussion = state(["seer", "villager"], "discussion");
    expect(getAvailableActions(discussion, uid("p0"))).toEqual([]);
    const game = state(["werewolf", "villager"], "night", ["p0"]);
    expect(getAvailableActions(game, uid("p0"))).toEqual([]);
  });

  test("the stored intent is reflected as the selected target", () => {
    let game = state(["werewolf", "villager", "werewolf"]);
    game = apply(game, "p0", {
      commandId: "c1",
      phaseId: game.phase!.id,
      type: "night.action.set",
      payload: { action: "wolf.attack", targetId: uid("p1") },
    });
    expect(getAvailableActions(game, uid("p0"))).toEqual([
      {
        id: "wolf.attack",
        type: "target",
        targets: [
          { userId: uid("p1"), enabled: true },
          { userId: uid("p2"), enabled: false },
        ],
        selectedTargetId: uid("p1"),
      },
    ]);
  });

  test("harlot.stay is reported as selected once chosen", () => {
    let game = state(["harlot", "villager"]);
    game = apply(game, "p0", {
      commandId: "c1",
      phaseId: game.phase!.id,
      type: "night.action.set",
      payload: { action: "harlot.stay" },
    });
    expect(getAvailableActions(game, uid("p0"))).toEqual([
      {
        id: "harlot.visit",
        type: "target",
        targets: [{ userId: uid("p1"), enabled: true }],
      },
      { id: "harlot.stay", type: "choice", selected: true },
    ]);
  });
});
