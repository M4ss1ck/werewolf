import { describe, expect, test } from "bun:test";
import { applyCommand } from "../commands/apply.ts";
import type { DomainResult, DomainTransition, GameState, PlayerState } from "../state.ts";
import { resolveDayVote } from "./vote.ts";

function state(
  roles: PlayerState["role"][],
  phaseId = 1,
  endsAt = 100,
  nightsWithoutElimination = 0,
): GameState {
  const players = Object.fromEntries(
    roles.map((role, index) => {
      const id = `p${index}` as PlayerState["id"];
      return [
        id,
        {
          id,
          status: "alive",
          originalRole: role,
          role,
          faction: role === "werewolf" ? "wolves" : "village",
          roleState: role === "princess" ? { lynchProtectionUsed: false } : {},
          phaseState: { phaseId },
        },
      ];
    }),
  );
  return {
    id: "g" as GameState["id"],
    ownerUserId: "p0" as PlayerState["id"],
    status: "running",
    day: 1,
    phase: {
      id: phaseId as GameState["phase"] extends infer P
        ? P extends { id: infer I }
          ? I
          : never
        : never,
      type: "voting",
      startedAt: 0,
      endsAt,
    },
    players,
    settings: { discussionDurationMs: 1, votingDurationMs: 1, nightDurationMs: 1 },
    balanceVersion: 1,
    nightsWithoutElimination,
    winner: null,
    version: 1,
  } as unknown as GameState;
}
function expectTransition(result: DomainResult): DomainTransition {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  return result.transition;
}
function vote(
  game: GameState,
  playerId: string,
  targetId: string,
  commandId: string,
  now = 1,
): GameState {
  const transition = expectTransition(
    applyCommand(
      game,
      playerId as PlayerState["id"],
      {
        commandId,
        phaseId: game.phase!.id,
        type: "vote.set",
        payload: { targetId: targetId as PlayerState["id"] },
      },
      { now },
    ),
  );
  return {
    ...game,
    players: {
      ...game.players,
      [playerId]: {
        ...game.players[playerId as PlayerState["id"]]!,
        ...transition.playerPatches[0]!.changes,
      },
    },
  };
}

describe("day vote resolution", () => {
  test("a decided day vote finishes off every living loser", () => {
    let game = state(["werewolf", "werewolf", "villager", "princess"]);
    for (const voter of ["p0", "p1"]) game = vote(game, voter, "p2", voter);

    const transition = expectTransition(resolveDayVote(game));

    expect(transition.playerPatches.filter((patch) => patch.changes.status === "dead")).toEqual([
      { playerId: "p2" as PlayerState["id"], changes: { status: "dead" } },
      { playerId: "p3" as PlayerState["id"], changes: { status: "dead" } },
    ]);
    expect(transition.events).toContainEqual({
      kind: "players.finished_off",
      scope: "public",
      payload: { playerIds: ["p3" as PlayerState["id"]], winningFaction: "wolves" },
    });
    expect(transition.events.at(-1)?.kind).toBe("game.finished");
    expect(transition.events.filter((event) => event.kind === "player.eliminated")).toHaveLength(1);
    expect(transition.events.some((event) => event.kind === "princess.revealed")).toBe(false);
  });

  test.each([
    [["villager", "villager", "villager", "werewolf", "villager"], "p1"],
    [["villager", "villager", "werewolf", "villager", "villager"], "p2"],
  ])("unique plurality eliminates the selected player", (roles, target) => {
    let game = state(roles as PlayerState["role"][]);
    for (const voter of ["p0", "p3", "p4"]) game = vote(game, voter, target, voter);
    game = vote(game, "p1", "p0", "change");
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === target && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });

  test("tie eliminates nobody and distinguishes abstention from no vote", () => {
    let game = state([
      "villager",
      "villager",
      "villager",
      "villager",
      "werewolf",
    ] as PlayerState["role"][]);
    game = vote(game, "p0", "p1", "a");
    game = vote(game, "p1", "p2", "b");
    const abstain = expectTransition(
      applyCommand(
        game,
        "p3" as PlayerState["id"],
        { commandId: "d", phaseId: game.phase!.id, type: "vote.abstain", payload: {} },
        { now: 1 },
      ),
    );
    game = {
      ...game,
      players: {
        ...game.players,
        p3: { ...game.players["p3" as PlayerState["id"]]!, ...abstain.playerPatches[0]!.changes },
      },
    } as GameState;
    const transition = expectTransition(resolveDayVote(game));
    expect(transition.events[0]).toMatchObject({
      kind: "vote.resolved",
      payload: { eliminated: null, abstain: 1, noVote: 2 },
    });
  });

  test("Princess survives first selection and dies on second", () => {
    let game = state([
      "princess",
      "villager",
      "villager",
      "werewolf",
      "villager",
    ] as PlayerState["role"][]);
    for (const voter of ["p1", "p2", "p3"]) game = vote(game, voter, "p0", voter);
    let transition = expectTransition(resolveDayVote(game));
    expect(transition.playerPatches[0]!.changes.status).toBeUndefined();
    game = {
      ...game,
      players: {
        ...game.players,
        p0: {
          ...game.players["p0" as PlayerState["id"]]!,
          ...transition.playerPatches[0]!.changes,
        },
      },
    } as GameState;
    for (const voter of ["p1", "p2", "p3"]) game = vote(game, voter, "p0", `again-${voter}`);
    transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p0" && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });

  test("a later vote replaces an earlier one before the deadline", () => {
    let game = state(["villager", "villager", "villager", "werewolf"] as PlayerState["role"][]);
    game = vote(game, "p0", "p1", "first");
    game = vote(game, "p0", "p2", "second");
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p2" && patch.changes.status === "dead",
      ),
    ).toBe(true);
    expect(transition.playerPatches.some((patch) => patch.playerId === "p1")).toBe(false);
  });

  test("voting for yourself is allowed and counted normally", () => {
    let game = state(["villager", "villager", "werewolf"] as PlayerState["role"][]);
    game = vote(game, "p0", "p0", "self");
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p0" && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });

  test("the village wins when the last living wolf is eliminated", () => {
    let game = state(["villager", "villager", "villager", "werewolf"] as PlayerState["role"][]);
    for (const voter of ["p0", "p1", "p2"]) game = vote(game, voter, "p3", voter);
    const transition = expectTransition(resolveDayVote(game));
    expect(transition.gamePatch).toMatchObject({
      status: "finished",
      winner: { winningFactions: ["village"], reason: "wolves_eliminated" },
    });
    expect(
      transition.events.some((event) => event.kind === "game.finished" && event.scope === "public"),
    ).toBe(true);
  });

  test("lynching the veteran ends the game with the veteran winning", () => {
    let game = state([
      "veteran",
      "villager",
      "villager",
      "werewolf",
      "villager",
    ] as PlayerState["role"][]);
    for (const voter of ["p1", "p2", "p3"]) game = vote(game, voter, "p0", voter);
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p0" && patch.changes.status === "dead",
      ),
    ).toBe(true);
    expect(transition.gamePatch).toMatchObject({
      status: "finished",
      winner: {
        winningFactions: ["veteran"],
        winningPlayers: ["p0"],
        reason: "veteran_lynched",
      },
    });
    expect(
      transition.events.some((event) => event.kind === "game.finished" && event.scope === "public"),
    ).toBe(true);
  });

  test("a day vote that eliminates a player while the game continues resets nightsWithoutElimination to 0", () => {
    // Two wolves and two villagers: lynching a villager leaves the game running.
    let game = state(
      ["villager", "villager", "werewolf", "werewolf"] as PlayerState["role"][],
      1,
      100,
      3,
    );
    for (const voter of ["p0", "p1", "p2"]) game = vote(game, voter, "p0", voter);
    const transition = expectTransition(resolveDayVote(game));
    expect(
      transition.playerPatches.some(
        (patch) => patch.playerId === "p0" && patch.changes.status === "dead",
      ),
    ).toBe(true);
    expect(transition.gamePatch).toMatchObject({
      status: "finished",
      nightsWithoutElimination: 0,
      winner: {
        winningFactions: ["wolves"],
        winningPlayers: ["p2", "p3"],
        reason: "village_eliminated",
      },
    });
  });

  test("a day vote that eliminates nobody does not reset nightsWithoutElimination", () => {
    // A tie eliminates nobody; the game continues and the counter is untouched.
    let game = state(
      ["villager", "villager", "werewolf", "werewolf"] as PlayerState["role"][],
      1,
      100,
      3,
    );
    game = vote(game, "p0", "p1", "a");
    game = vote(game, "p1", "p0", "b");
    const transition = expectTransition(resolveDayVote(game));
    expect(transition.gamePatch).toMatchObject({
      status: "finished",
      nightsWithoutElimination: 3,
      winner: {
        winningFactions: ["wolves"],
        winningPlayers: ["p2", "p3"],
        reason: "village_eliminated",
      },
    });
  });
});

test("stale and late commands are rejected", () => {
  const game = state([
    "villager",
    "villager",
    "villager",
    "villager",
    "werewolf",
  ] as PlayerState["role"][]);
  expect(
    applyCommand(
      game,
      "p0" as PlayerState["id"],
      {
        commandId: "x",
        phaseId: 0 as GameState["phase"] extends infer P
          ? P extends { id: infer I }
            ? I
            : never
          : never,
        type: "vote.abstain",
        payload: {},
      },
      { now: 1 },
    ),
  ).toEqual({ ok: false, error: { code: "PHASE_MISMATCH" } });
  expect(
    applyCommand(
      game,
      "p0" as PlayerState["id"],
      { commandId: "x", phaseId: game.phase!.id, type: "vote.abstain", payload: {} },
      { now: 100 },
    ),
  ).toEqual({ ok: false, error: { code: "PHASE_CLOSED" } });
});
