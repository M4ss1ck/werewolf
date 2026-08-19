import { describe, expect, test } from "bun:test";
import type { EventPayloads } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import { DRUNK_FAKE_ROLES } from "../composer/balance-v1.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import { projectSnapshot } from "../projection/snapshot.ts";
import { SeededRng } from "../rng/rng.ts";
import type { DomainTransition, GameState, PlayerState } from "../state.ts";
import { resolveNight } from "./night.ts";
import { startGame } from "./phase.ts";

const id = (value: string) => value as PlayerState["id"];

function makeState(
  roles: PlayerState["role"][],
  actions: Record<string, Record<string, unknown>> = {},
  roleStates: Record<string, unknown> = {},
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
            role === "werewolf" || role === "alpha_wolf"
              ? "wolves"
              : role === "serial_killer"
                ? "serial_killer"
                : role === "veteran"
                  ? "veteran"
                  : "village",
          roleState: roleStates[`p${index}`] ?? {},
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

function resolve(state: GameState, seed = "seed"): DomainTransition {
  const result = resolveNight(state, { now: 100, rng: new SeededRng(seed) });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.transition;
}

function makeLobby(count: number): GameState {
  const players = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const playerId = id(`p${index}`);
      return [
        playerId,
        {
          id: playerId,
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
    id: id("g") as unknown as GameState["id"],
    ownerUserId: id("p0"),
    status: "lobby",
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

/** The first startGame result that deals a Drunk, plus that Drunk's player id. */
function startWithDrunk(): { transition: DomainTransition; drunkId: string } {
  for (let seed = 0; seed < 2000; seed += 1) {
    const result = startGame(makeLobby(8), { now: 100, seed });
    if (!result.ok) continue;
    const drunk = result.transition.playerPatches.find((patch) => patch.changes.role === "drunk");
    if (drunk) return { transition: result.transition, drunkId: String(drunk.playerId) };
  }
  throw new Error("no composition with a drunk found");
}

describe("the Drunk's perceived role", () => {
  test("a Drunk who believes they are the Seer is offered seer.inspect", () => {
    const game = makeState(
      ["drunk", "villager", "villager"],
      {},
      { p0: { perceivedRole: "seer" } },
    );
    expect(getAvailableActions(game, id("p0"))).toEqual([
      {
        id: "seer.inspect",
        type: "target",
        targets: [
          { userId: id("p1"), enabled: true },
          { userId: id("p2"), enabled: true },
        ],
      },
    ]);
  });

  test("a Drunk who believes they are the Seer may submit seer.inspect", () => {
    const game = makeState(
      ["drunk", "villager", "villager"],
      {},
      { p0: { perceivedRole: "seer" } },
    );
    const result = validateCommand(
      game,
      id("p0"),
      {
        commandId: "c1",
        phaseId: game.phase!.id,
        type: "night.action.set",
        payload: { action: "seer.inspect", targetId: id("p1") },
      },
      { now: 1 },
    );
    expect(result).toBeNull();
  });

  test("me.role is the perceived role and me.roleState hides the drunk state", () => {
    const game = makeState(["drunk", "villager"], {}, { p0: { perceivedRole: "seer" } });
    const snapshot = projectSnapshot(game, id("p0"));
    expect(snapshot.me?.role).toBe("seer");
    expect(snapshot.me?.roleState).not.toHaveProperty("perceivedRole");
  });

  test("the role.assigned event a Drunk receives names the perceived role", () => {
    const { transition, drunkId } = startWithDrunk();
    const event = transition.events.find(
      (candidate) => candidate.kind === "role.assigned" && candidate.scopeId === drunkId,
    );
    expect(event).toBeDefined();
    const role = (event!.payload as EventPayloads["role.assigned"]).role;
    // Which fake role is dealt is seed-dependent (the composer pool changed with
    // the Sorcerer); the contract is that it is one of the fake roles, never the
    // Drunk's true role.
    expect(DRUNK_FAKE_ROLES).toContain(role);
    expect(role).not.toBe("drunk");
  });
});

describe("the Drunk's night result", () => {
  test("a Drunk who inspects at night receives a seer.result event", () => {
    const game = makeState(
      ["drunk", "villager", "villager"],
      { p0: { "seer.inspect": { targetId: id("p1") } } },
      { p0: { perceivedRole: "seer" } },
    );
    const transition = resolve(game);
    const result = transition.events.find(
      (candidate) => candidate.kind === "seer.result" && candidate.scopeId === id("p0"),
    );
    expect(result).toBeDefined();
    const payload = result!.payload as EventPayloads["seer.result"];
    expect(payload.targetId).toBe(id("p1"));
    expect(ROLE_IDS).toContain(payload.role);
  });

  test("a real Seer still receives their true result alongside the Drunk's fake one", () => {
    const game = makeState(
      ["drunk", "seer", "villager", "villager"],
      {
        p0: { "seer.inspect": { targetId: id("p2") } },
        p1: { "seer.inspect": { targetId: id("p3") } },
      },
      { p0: { perceivedRole: "seer" } },
    );
    const transition = resolve(game);
    const results = transition.events.filter((candidate) => candidate.kind === "seer.result");
    const real = results.find((candidate) => candidate.scopeId === id("p1"));
    const fake = results.find((candidate) => candidate.scopeId === id("p0"));
    expect(real).toBeDefined();
    expect((real!.payload as EventPayloads["seer.result"]).role).toBe("villager");
    expect(fake).toBeDefined();
  });

  test("a Drunk is not treated as the real Seer by freezeNightIntents", () => {
    const game = makeState(
      ["drunk", "villager", "villager"],
      { p0: { "seer.inspect": { targetId: id("p1") } } },
      { p0: { perceivedRole: "seer" } },
    );
    const transition = resolve(game);
    const audit = transition.events.find((candidate) => candidate.kind === "audit.night");
    expect((audit!.payload as EventPayloads["audit.night"]).seerInspection).toBeNull();
    const results = transition.events.filter((candidate) => candidate.kind === "seer.result");
    expect(results).toHaveLength(1);
    expect(results[0]!.scopeId).toBe(id("p0"));
  });
});

describe("the Drunk's true role on death", () => {
  test("player.eliminated reports the true role drunk, not the perceived role", () => {
    const game = makeState(
      ["werewolf", "drunk", "villager"],
      { p0: { "wolf.attack": { targetId: id("p1") } } },
      { p1: { perceivedRole: "seer" } },
    );
    const transition = resolve(game);
    const eliminated = transition.events.find(
      (candidate) => candidate.kind === "player.eliminated",
    );
    expect((eliminated!.payload as EventPayloads["player.eliminated"]).role).toBe("drunk");
  });
});

describe("determinism", () => {
  test("two startGame calls with the same seed draw the same fake role", () => {
    const first = startGame(makeLobby(8), { now: 100, seed: 0 });
    const second = startGame(makeLobby(8), { now: 100, seed: 0 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    const drunkOf = (transition: DomainTransition) =>
      transition.playerPatches.find((patch) => patch.changes.role === "drunk")?.changes.roleState;
    expect(drunkOf(first.transition)).toEqual(drunkOf(second.transition));
  });

  test("a game seeded identically produces the same role shuffle as before this change", () => {
    // Seed 9 at 8 players composes to a fixed role list; pinning it here
    // catches a reordered or reused `assignment` derive call. The pool gained
    // the Detective since this was last pinned, so the composition for seed 9
    // moved ("veteran" became "serial_killer"); the shuffle itself is stable.
    const result = startGame(makeLobby(8), { now: 100, seed: 9 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const shuffle = result.transition.playerPatches.map((patch) => patch.changes.role);
    expect(shuffle).toEqual([
      "seer",
      "werewolf",
      "villager",
      "werewolf",
      "serial_killer",
      "villager",
      "villager",
      "villager",
    ]);
  });
});
