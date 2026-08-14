import { describe, expect, test } from "bun:test";
import type { ActionId, GameplayCommand, NightActionSetPayload, UserId } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { applyCommand } from "./apply.ts";
import { validateCommand } from "./validate.ts";

const uid = (id: string) => id as PlayerState["id"];

function state(
  roles: PlayerState["role"][],
  phase: "discussion" | "voting" | "night" = "night",
  phaseId = 1,
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
          phaseState: { phaseId },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    status: "running",
    day: 1,
    phase: { id: phaseId as never, type: phase, startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function setAction(payload: NightActionSetPayload, phaseId = 1, commandId = "c1"): GameplayCommand {
  return { commandId, phaseId: phaseId as never, type: "night.action.set", payload };
}

function clearAction(action: ActionId, phaseId = 1, commandId = "c1"): GameplayCommand {
  return { commandId, phaseId: phaseId as never, type: "night.action.clear", payload: { action } };
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

describe("night action validation", () => {
  test.each([
    ["werewolf", "wolf.attack", { action: "wolf.attack", targetId: uid("p1") }],
    ["seer", "seer.inspect", { action: "seer.inspect", targetId: uid("p1") }],
    ["harlot", "harlot.visit", { action: "harlot.visit", targetId: uid("p1") }],
    ["harlot", "harlot.stay", { action: "harlot.stay" }],
  ] as const)("a %s may submit %s during night", (role, _action, payload) => {
    const game = state([role, "villager", "villager"] as PlayerState["role"][]);
    const result = validateCommand(game, uid("p0"), setAction(payload), { now: 1 });
    expect(result).toBeNull();
  });

  test.each([
    ["werewolf", "wolf.attack", { action: "wolf.attack", targetId: uid("p1") }, "discussion"],
    ["werewolf", "wolf.attack", { action: "wolf.attack", targetId: uid("p1") }, "voting"],
    ["seer", "seer.inspect", { action: "seer.inspect", targetId: uid("p1") }, "discussion"],
    ["harlot", "harlot.visit", { action: "harlot.visit", targetId: uid("p1") }, "voting"],
    ["harlot", "harlot.stay", { action: "harlot.stay" }, "discussion"],
  ] as const)("%s %s is rejected outside night", (role, _action, payload, phase) => {
    const game = state([role, "villager", "villager"] as PlayerState["role"][], phase);
    const result = validateCommand(game, uid("p0"), setAction(payload), { now: 1 });
    expect(result).toEqual({ code: "ACTION_NOT_AVAILABLE" });
  });

  test("night.action.clear is rejected outside night", () => {
    const game = state(["werewolf", "villager"] as PlayerState["role"][], "discussion");
    const result = validateCommand(game, uid("p0"), clearAction("wolf.attack"), { now: 1 });
    expect(result).toEqual({ code: "ACTION_NOT_AVAILABLE" });
  });

  test("a wolf may not target a fellow wolf", () => {
    const game = state(["werewolf", "werewolf", "villager"] as PlayerState["role"][]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "wolf.attack", targetId: uid("p1") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("the seer may not inspect herself", () => {
    const game = state(["seer", "villager"] as PlayerState["role"][]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "seer.inspect", targetId: uid("p0") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("the harlot may not visit herself", () => {
    const game = state(["harlot", "villager"] as PlayerState["role"][]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "harlot.visit", targetId: uid("p0") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("a villager is not granted the seer's action", () => {
    const game = state(["villager", "villager"] as PlayerState["role"][]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "seer.inspect", targetId: uid("p1") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "ACTION_NOT_AVAILABLE" });
  });

  test("a wolf may not attack a dead player", () => {
    const game = state(["werewolf", "villager"], "night", 1, ["p1"]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "wolf.attack", targetId: uid("p1") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("the seer may not inspect a dead player", () => {
    const game = state(["seer", "villager"], "night", 1, ["p1"]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "seer.inspect", targetId: uid("p1") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("a dead actor is not alive and gets no night action", () => {
    const game = state(["werewolf", "villager"], "night", 1, ["p0"]);
    const result = validateCommand(
      game,
      uid("p0"),
      setAction({ action: "wolf.attack", targetId: uid("p1") }),
      { now: 1 },
    );
    expect(result).toEqual({ code: "NOT_ALIVE" });
  });
});

describe("night action storage", () => {
  test("night.action.set replaces an earlier intent for the same action", () => {
    let game = state(["werewolf", "villager", "villager"] as PlayerState["role"][]);
    game = apply(game, "p0", setAction({ action: "wolf.attack", targetId: uid("p1") }, 1, "first"));
    game = apply(
      game,
      "p0",
      setAction({ action: "wolf.attack", targetId: uid("p2") }, 1, "second"),
    );
    expect(game.players[uid("p0")]!.phaseState).toEqual({
      phaseId: 1 as never,
      actions: { "wolf.attack": { targetId: uid("p2") } },
    });
  });

  test("night.action.clear removes a stored intent", () => {
    let game = state(["seer", "villager"] as PlayerState["role"][]);
    game = apply(game, "p0", setAction({ action: "seer.inspect", targetId: uid("p1") }));
    game = apply(game, "p0", clearAction("seer.inspect"));
    expect(game.players[uid("p0")]!.phaseState.actions).toEqual({});
  });

  test("harlot.visit and harlot.stay replace each other", () => {
    let game = state(["harlot", "villager"] as PlayerState["role"][]);
    game = apply(game, "p0", setAction({ action: "harlot.visit", targetId: uid("p1") }));
    game = apply(game, "p0", setAction({ action: "harlot.stay" }));
    expect(game.players[uid("p0")]!.phaseState.actions).toEqual({ "harlot.stay": {} });
    game = apply(game, "p0", setAction({ action: "harlot.visit", targetId: uid("p1") }));
    expect(game.players[uid("p0")]!.phaseState.actions).toEqual({
      "harlot.visit": { targetId: uid("p1") },
    });
  });
});
