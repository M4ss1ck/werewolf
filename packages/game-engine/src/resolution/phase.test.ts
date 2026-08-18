import { describe, expect, test } from "bun:test";
import type { DomainTransition, GameState, PlayerState } from "../state.ts";
import { resolveExpiredPhase, resolveScheduledGame, startGame } from "./phase.ts";

function makeState(count: number, status: GameState["status"] = "lobby"): GameState {
  const players = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const id = `p${index}` as PlayerState["id"];
      return [
        id,
        {
          id,
          status: "lobby" as const,
          originalRole: null,
          role: null,
          faction: null,
          roleState: null,
          phaseState: { phaseId: 0 },
        },
      ];
    }),
  );
  return {
    id: "game" as GameState["id"],
    ownerUserId: "p0" as PlayerState["id"],
    status,
    day: 0,
    phase: null,
    players: players as GameState["players"],
    settings: { discussionDurationMs: 10, votingDurationMs: 20, nightDurationMs: 30 },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  };
}

function transition(result: ReturnType<typeof startGame>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.transition;
}

describe("game start and phase orchestration", () => {
  test("refuses to start with fewer than five players", () => {
    expect(startGame(makeState(4), { now: 100, seed: "seed" })).toEqual({
      ok: false,
      error: { code: "MIN_PLAYERS_NOT_REACHED" },
    });
  });

  test("assigns every player a role, faction, and alive status", () => {
    const result = transition(startGame(makeState(5), { now: 100, seed: "seed" }));
    expect(result.gamePatch).toMatchObject({ status: "running", day: 1 });
    expect(result.playerPatches).toHaveLength(5);
    for (const patch of result.playerPatches)
      expect(patch.changes).toMatchObject({ status: "alive" });
    expect(result.playerPatches.every((patch) => patch.changes.role && patch.changes.faction)).toBe(
      true,
    );
  });

  test("assignment is deterministic by seed", () => {
    const assignment = (seed: string) =>
      transition(startGame(makeState(5), { now: 100, seed })).playerPatches.map(
        (patch) => patch.changes.role,
      );
    expect(assignment("same")).toEqual(assignment("same"));
    expect(assignment("same")).not.toEqual(assignment("different"));
  });

  test("sends role assignments only to their respective players", () => {
    const result = transition(startGame(makeState(5), { now: 100, seed: "seed" }));
    const events = result.events.filter((event) => event.kind === "role.assigned");
    expect(events).toHaveLength(5);
    expect(new Set(events.map((event) => event.scopeId)).size).toBe(5);
    expect(events.every((event) => event.scope === "player")).toBe(true);
  });

  test("teaches wolves and masons only their own groups", () => {
    let result: DomainTransition | undefined;
    for (let seed = 0; seed < 100; seed += 1) {
      const candidate = transition(startGame(makeState(8), { now: 100, seed }));
      if (candidate.playerPatches.filter((patch) => patch.changes.role === "mason").length === 2) {
        result = candidate;
        break;
      }
    }
    expect(result).toBeDefined();
    const privateEvents = result!.events.filter(
      (event) => event.kind === "wolves.member_joined" || event.kind === "masons.member_joined",
    );
    expect(privateEvents.length).toBeGreaterThan(0);
    for (const event of privateEvents) expect(event.scope).toBe("player");
    const wolves = result!.playerPatches
      .filter((patch) => patch.changes.faction === "wolves")
      .map((patch) => patch.playerId);
    const masons = result!.playerPatches
      .filter((patch) => patch.changes.role === "mason")
      .map((patch) => patch.playerId);
    expect(
      privateEvents
        .filter((event) => event.kind === "wolves.member_joined")
        .every((event) => wolves.includes(event.scopeId as PlayerState["id"])),
    ).toBe(true);
    expect(
      privateEvents
        .filter((event) => event.kind === "masons.member_joined")
        .every((event) => masons.includes(event.scopeId as PlayerState["id"])),
    ).toBe(true);
  });

  test("opens discussion, voting, night, and next discussion with unique phases", () => {
    let game = makeState(5);
    const started = transition(startGame(game, { now: 100, seed: "seed" }));
    game = {
      ...game,
      status: "running",
      day: 1,
      phase: started.gamePatch!.phase!,
      players: Object.fromEntries(
        started.playerPatches.map((patch) => [
          patch.playerId,
          { ...game.players[patch.playerId], ...patch.changes },
        ]),
      ) as GameState["players"],
    };
    if (!game.phase) throw new Error("expected initial phase");
    const ids = [game.phase.id];
    for (const [now, type] of [
      [110, "discussion"],
      [120, "voting"],
      [130, "night"],
    ] as const) {
      if (!game.phase) throw new Error("expected phase");
      expect(game.phase.type).toBe(type);
      const result = transition(resolveExpiredPhase(game, { now, seed: "seed" }));
      game = {
        ...game,
        day: game.day + (type === "night" ? 1 : 0),
        phase: result.gamePatch!.phase!,
      };
      if (!game.phase) throw new Error("expected next phase");
      ids.push(game.phase.id);
    }
    expect(ids.map(Number)).toEqual([1, 2, 3, 4]);
    expect(game.day).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("starts a scheduled game when enough players joined", () => {
    const result = transition(
      resolveScheduledGame(makeState(5, "scheduled"), { now: 100, seed: "seed" }),
    );
    expect(result.gamePatch).toMatchObject({ status: "running", day: 1 });
  });

  test("returns a short scheduled game to the lobby", () => {
    const result = transition(
      resolveScheduledGame(makeState(4, "scheduled"), { now: 100, seed: "seed" }),
    );
    expect(result.gamePatch).toMatchObject({ status: "lobby", scheduledAt: null });
    expect(result.events).toContainEqual({
      kind: "game.start_deferred",
      scope: "public",
      payload: { joinedPlayers: 4, minimumPlayers: 5 },
    });
  });
});
