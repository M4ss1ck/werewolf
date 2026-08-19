import { describe, expect, test } from "bun:test";
import type { GameplayCommand } from "@werewolf/protocol";
import { applyCommand } from "../commands/apply.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import type { DomainResult, DomainTransition, GameState, PlayerState } from "../state.ts";
import { resolveDayVote } from "./vote.ts";

const uid = (id: string) => id as PlayerState["id"];

function state(
  roles: PlayerState["role"][],
  phase: "discussion" | "voting" | "night" = "voting",
  day = 1,
  dead: string[] = [],
  roleStates: Record<string, unknown> = {},
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
          roleState:
            roleStates[id] ??
            (role === "princess"
              ? { lynchProtectionUsed: false }
              : role === "mayor"
                ? { used: false, overrideDay: null, overrideTarget: null }
                : {}),
          phaseState: { phaseId: 1 },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    ownerUserId: uid("p0"),
    status: "running",
    day,
    phase: { id: 1 as never, type: phase, startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function expectTransition(result: DomainResult): DomainTransition {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  return result.transition;
}

function apply(game: GameState, actorId: string, command: GameplayCommand): GameState {
  const transition = expectTransition(applyCommand(game, uid(actorId), command, { now: 1 }));
  const patch = transition.playerPatches[0]!;
  return {
    ...game,
    players: {
      ...game.players,
      [patch.playerId]: { ...game.players[patch.playerId]!, ...patch.changes },
    },
  };
}

function vote(game: GameState, playerId: string, targetId: string, commandId: string): GameState {
  return apply(game, playerId, {
    commandId,
    phaseId: game.phase!.id,
    type: "vote.set",
    payload: { targetId: uid(targetId) },
  });
}

function dayAction(
  game: GameState,
  actorId: string,
  payload: { action: "mayor.reveal"; targetId: string } | { action: "mayor.pardon" },
  commandId = "c",
): GameState {
  return apply(game, actorId, {
    commandId,
    phaseId: game.phase!.id,
    type: "day.action.set",
    payload:
      payload.action === "mayor.reveal"
        ? { action: "mayor.reveal", targetId: uid(payload.targetId) }
        : { action: "mayor.pardon" },
  });
}

describe("mayor day action", () => {
  test("a mayor is offered reveal and pardon during discussion and voting, but not at night", () => {
    for (const phase of ["discussion", "voting"] as const) {
      const game = state(["mayor", "villager", "villager"], phase);
      expect(getAvailableActions(game, uid("p0"))).toEqual([
        {
          id: "mayor.reveal",
          type: "target",
          targets: [
            { userId: uid("p1"), enabled: true },
            { userId: uid("p2"), enabled: true },
          ],
        },
        { id: "mayor.pardon", type: "choice" },
      ]);
    }
    const night = state(["mayor", "villager", "villager"], "night");
    expect(getAvailableActions(night, uid("p0"))).toEqual([]);
  });

  test("a non-mayor is offered neither", () => {
    for (const phase of ["discussion", "voting"] as const) {
      const game = state(["villager", "mayor", "villager"], phase);
      expect(getAvailableActions(game, uid("p0"))).toEqual([]);
    }
  });

  test("a mayor who has already used it is offered neither, and a second action is rejected", () => {
    const game = state(["mayor", "villager", "villager"], "voting", 1, [], {
      p0: { used: true, overrideDay: 1, overrideTarget: uid("p1") },
    });
    expect(getAvailableActions(game, uid("p0"))).toEqual([]);
    const result = applyCommand(
      game,
      uid("p0"),
      {
        commandId: "c",
        phaseId: game.phase!.id,
        type: "day.action.set",
        payload: { action: "mayor.pardon" },
      },
      { now: 1 },
    );
    expect(result).toEqual({ ok: false, error: { code: "ACTION_NOT_AVAILABLE" } });
  });

  test("mayor.reveal emits a public mayor.revealed event carrying the target", () => {
    const game = state(["mayor", "villager", "villager"], "voting");
    const transition = expectTransition(
      applyCommand(
        game,
        uid("p0"),
        {
          commandId: "c",
          phaseId: game.phase!.id,
          type: "day.action.set",
          payload: { action: "mayor.reveal", targetId: uid("p1") },
        },
        { now: 1 },
      ),
    );
    expect(transition.events).toEqual([
      {
        kind: "mayor.revealed",
        scope: "public",
        actorUserId: uid("p0"),
        payload: { playerId: uid("p0"), targetId: uid("p1") },
      },
    ]);
  });

  test("mayor.pardon emits it with targetId null", () => {
    const game = state(["mayor", "villager", "villager"], "voting");
    const transition = expectTransition(
      applyCommand(
        game,
        uid("p0"),
        {
          commandId: "c",
          phaseId: game.phase!.id,
          type: "day.action.set",
          payload: { action: "mayor.pardon" },
        },
        { now: 1 },
      ),
    );
    expect(transition.events).toEqual([
      {
        kind: "mayor.revealed",
        scope: "public",
        actorUserId: uid("p0"),
        payload: { playerId: uid("p0"), targetId: null },
      },
    ]);
  });

  test("the override replaces the tally winner", () => {
    // Tally elects p1; the mayor names p2.
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "voting");
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    game = dayAction(game, "p0", { action: "mayor.reveal", targetId: "p2" });
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p2" && patch.changes.status === "dead",
      ),
    ).toBe(true);
    expect(transition.playerPatches.some((patch) => patch.playerId === "p1")).toBe(false);
    const resolved = transition.events.find((event) => event.kind === "vote.resolved");
    expect(resolved).toMatchObject({ payload: { eliminated: uid("p2") } });
  });

  test("vote.resolved still carries the real tallies even when overridden", () => {
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "voting");
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    game = dayAction(game, "p0", { action: "mayor.reveal", targetId: "p2" });
    const transition = expectTransition(resolveDayVote(game));
    const resolved = transition.events.find((event) => event.kind === "vote.resolved");
    expect(resolved).toMatchObject({
      payload: {
        tallies: [{ targetId: uid("p1"), count: 3 }],
        abstain: 0,
        noVote: 2,
      },
    });
  });

  test("mayor.pardon means nobody is eliminated even though the tally had a unique winner", () => {
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "voting");
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    game = dayAction(game, "p0", { action: "mayor.pardon" });
    const transition = expectTransition(resolveDayVote(game));
    expect(transition.playerPatches.some((patch) => patch.changes.status === "dead")).toBe(false);
    const resolved = transition.events.find((event) => event.kind === "vote.resolved");
    expect(resolved).toMatchObject({ payload: { eliminated: null } });
  });

  test("an override naming a player who is dead at resolution eliminates nobody", () => {
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "voting");
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    game = dayAction(game, "p0", { action: "mayor.reveal", targetId: "p2" });
    // p2 dies before the vote resolves.
    game = {
      ...game,
      players: {
        ...game.players,
        p2: { ...game.players["p2" as PlayerState["id"]]!, status: "dead" },
      },
    } as GameState;
    const transition = expectTransition(resolveDayVote(game));
    expect(transition.playerPatches.some((patch) => patch.changes.status === "dead")).toBe(false);
    const resolved = transition.events.find((event) => event.kind === "vote.resolved");
    expect(resolved).toMatchObject({ payload: { eliminated: null } });
  });

  test("overriding onto the veteran still ends the game with veteran_lynched", () => {
    let game = state(["mayor", "veteran", "villager", "werewolf", "villager"], "voting");
    for (const voter of ["p0", "p2", "p3"]) game = vote(game, voter, "p2", voter);
    game = dayAction(game, "p0", { action: "mayor.reveal", targetId: "p1" });
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p1" && patch.changes.status === "dead",
      ),
    ).toBe(true);
    expect(transition.gamePatch).toMatchObject({
      status: "finished",
      winner: {
        winningFactions: ["veteran"],
        winningPlayers: ["p1"],
        reason: "veteran_lynched",
      },
    });
  });

  test("overriding onto the princess still triggers her one-time survival", () => {
    let game = state(["mayor", "princess", "villager", "werewolf", "villager"], "voting");
    for (const voter of ["p0", "p2", "p3"]) game = vote(game, voter, "p2", voter);
    game = dayAction(game, "p0", { action: "mayor.reveal", targetId: "p1" });
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p1" && patch.changes.status === "dead",
      ),
    ).toBe(false);
    expect(transition.events.some((event) => event.kind === "princess.revealed")).toBe(true);
  });

  test("an action taken during discussion still applies to the vote that resolves later the same day", () => {
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "discussion");
    game = dayAction(game, "p0", { action: "mayor.reveal", targetId: "p2" });
    // The phase advances to voting on the same day; the override must still apply.
    game = {
      ...game,
      phase: { id: 2 as never, type: "voting", startedAt: 0, endsAt: 100 },
    } as GameState;
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p2" && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });

  test("a mayor's override from a previous day does not apply to today's vote", () => {
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "voting", 2, [], {
      p0: { used: true, overrideDay: 1, overrideTarget: uid("p2") },
    });
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p1" && patch.changes.status === "dead",
      ),
    ).toBe(true);
    expect(transition.playerPatches.some((patch) => patch.playerId === "p2")).toBe(false);
  });

  test("a dead mayor's override does not apply", () => {
    let game = state(["mayor", "villager", "villager", "werewolf", "villager"], "voting", 1, [], {
      p0: { used: true, overrideDay: 1, overrideTarget: uid("p2") },
    });
    game = {
      ...game,
      players: {
        ...game.players,
        p0: { ...game.players["p0" as PlayerState["id"]]!, status: "dead" },
      },
    } as GameState;
    for (const voter of ["p1", "p3", "p4"]) game = vote(game, voter, "p1", voter);
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p1" && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });
});
