import { describe, expect, test } from "bun:test";
import type { EventPayloads, GameEvent } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import { canViewEvent } from "../projection/permissions.ts";
import { SeededRng } from "../rng/rng.ts";
import type { DomainTransition, GameState, PlayerState } from "../state.ts";
import { resolveNight } from "./night.ts";

const id = (value: string) => value as PlayerState["id"];

function makeState(
  roles: PlayerState["role"][],
  actions: Record<string, Record<string, unknown>> = {},
  roleStates: Record<string, unknown> = {},
  day = 1,
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
    day,
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

function deadPlayerIds(transition: DomainTransition): string[] {
  return transition.playerPatches
    .filter((patch) => patch.changes.status === "dead")
    .map((patch) => String(patch.playerId))
    .sort();
}

function detectiveResults(transition: DomainTransition) {
  return transition.events.filter((event) => event.kind === "detective.result");
}

// The seeds pin the new derive scopes. "d" rolls 0.078 (< 0.5, success) and
// "seed" rolls 0.951 (>= 0.5, inconclusive) on `night:1:detective:investigation`;
// "drunk-det" rolls 0.227 (success) and "seed" 0.913 (miss) on
// `night:1:drunk:fake-detective`.
describe("the Detective's night", () => {
  test("a successful investigation returns the target's TRUE role", () => {
    const game = makeState(["detective", "cursed", "villager"], {
      p0: { "detective.investigate": { targetId: id("p1") } },
    });
    const transition = resolve(game, "d");
    expect(transition.events).toContainEqual({
      kind: "detective.result",
      scope: "player",
      scopeId: id("p0"),
      payload: { targetId: id("p1"), role: "cursed" },
    });
  });

  test("a failed investigation returns role null, never a wrong role", () => {
    const game = makeState(["detective", "villager", "villager"], {
      p0: { "detective.investigate": { targetId: id("p1") } },
    });
    const transition = resolve(game, "seed");
    const results = detectiveResults(transition);
    expect(results).toHaveLength(1);
    const payload = results[0]!.payload as EventPayloads["detective.result"];
    expect(payload.targetId).toBe(id("p1"));
    expect(payload.role).toBeNull();
    expect(payload.role).not.toBe("villager");
  });

  test("the detective is placed at the target's house and dies when the pack attacks that house", () => {
    const game = makeState(["werewolf", "werewolf", "detective", "villager"], {
      p0: { "wolf.attack": { targetId: id("p3") } },
      p1: { "wolf.attack": { targetId: id("p3") } },
      p2: { "detective.investigate": { targetId: id("p3") } },
    });
    const transition = resolve(game);
    expect(deadPlayerIds(transition)).toEqual(["p2", "p3"]);
  });

  test("the detective survives when the pack attacks a different house", () => {
    const game = makeState(["werewolf", "detective", "villager", "villager"], {
      p0: { "wolf.attack": { targetId: id("p3") } },
      p1: { "detective.investigate": { targetId: id("p2") } },
    });
    const transition = resolve(game);
    expect(deadPlayerIds(transition)).toEqual(["p3"]);
  });

  test("the detective may not investigate themselves", () => {
    const game = makeState(["detective", "villager", "villager"]);
    const self = validateCommand(
      game,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "night.action.set",
        payload: { action: "detective.investigate", targetId: id("p0") },
      },
      { now: 1 },
    );
    expect(self).toEqual({ code: "INVALID_TARGET" });
    // Any other living player is a legal target.
    const other = validateCommand(
      game,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "night.action.set",
        payload: { action: "detective.investigate", targetId: id("p1") },
      },
      { now: 1 },
    );
    expect(other).toBeNull();
    // The offer lists other players only.
    const investigate = getAvailableActions(game, id("p0")).find(
      (action) => action.id === "detective.investigate",
    );
    expect(investigate?.type).toBe("target");
    if (investigate?.type === "target")
      expect(investigate.targets.map((target) => target.userId)).not.toContain(id("p0"));
  });

  test("the detective may investigate every night, on consecutive nights", () => {
    const night2 = makeState(["detective", "villager", "villager"], {}, {}, 2, 2);
    expect(getAvailableActions(night2, id("p0"))).toContainEqual({
      id: "detective.investigate",
      type: "target",
      targets: [
        { userId: id("p1"), enabled: true },
        { userId: id("p2"), enabled: true },
      ],
    });
    const first = resolve(
      makeState(
        ["detective", "villager", "villager"],
        { p0: { "detective.investigate": { targetId: id("p1") } } },
        {},
        1,
        1,
      ),
      "d",
    );
    const second = resolve(
      makeState(
        ["detective", "villager", "villager"],
        { p0: { "detective.investigate": { targetId: id("p2") } } },
        {},
        2,
        2,
      ),
      "d",
    );
    expect(detectiveResults(first)).toHaveLength(1);
    expect(detectiveResults(second)).toHaveLength(1);
  });

  test("the result is emitted even when the detective dies that night", () => {
    const game = makeState(["werewolf", "werewolf", "detective", "villager"], {
      p0: { "wolf.attack": { targetId: id("p3") } },
      p1: { "wolf.attack": { targetId: id("p3") } },
      p2: { "detective.investigate": { targetId: id("p3") } },
    });
    const transition = resolve(game, "d");
    expect(deadPlayerIds(transition)).toEqual(["p2", "p3"]);
    expect(transition.events).toContainEqual({
      kind: "detective.result",
      scope: "player",
      scopeId: id("p2"),
      payload: { targetId: id("p3"), role: "villager" },
    });
  });

  test("the result is private: it reaches nobody else's projection", () => {
    const state = makeState(["detective", "villager", "villager"]);
    const event: GameEvent = {
      id: 1 as GameEvent["id"],
      kind: "detective.result",
      scope: "player",
      scopeId: id("p0"),
      createdAt: 0,
      payload: { targetId: id("p1"), role: "villager" },
    };
    expect(canViewEvent(event, id("p0"), state)).toBe(true);
    expect(canViewEvent(event, id("p1"), state)).toBe(false);
    // In a real resolution the only detective.result is addressed to the detective.
    const game = makeState(["detective", "villager", "villager"], {
      p0: { "detective.investigate": { targetId: id("p1") } },
    });
    const transition = resolve(game, "d");
    const results = detectiveResults(transition);
    expect(results).toHaveLength(1);
    expect(results[0]!.scope).toBe("player");
    expect(results[0]!.scopeId).toBe(id("p0"));
  });
});

describe("the Drunk-Detective", () => {
  test("receives a result of the same shape as a real one, and a real Detective in the same game still gets the truth", () => {
    const game = makeState(
      ["drunk", "detective", "villager", "villager"],
      {
        p0: { "detective.investigate": { targetId: id("p2") } },
        p1: { "detective.investigate": { targetId: id("p3") } },
      },
      { p0: { perceivedRole: "detective" } },
    );
    const transition = resolve(game, "drunk-det");
    const results = detectiveResults(transition);
    expect(results).toHaveLength(2);
    const real = results.find((event) => event.scopeId === id("p1"));
    const fake = results.find((event) => event.scopeId === id("p0"));
    expect(real).toBeDefined();
    expect((real!.payload as EventPayloads["detective.result"]).role).toBe("villager");
    expect(fake).toBeDefined();
    const fakeRole = (fake!.payload as EventPayloads["detective.result"]).role;
    // The fake result is drawn from the role ids, never a lie.
    expect(fakeRole).not.toBeNull();
    expect(ROLE_IDS).toContain(fakeRole!);
    // Deterministic for the seed, but deliberately NOT pinned to a named role:
    // the draw indexes into ROLE_IDS, so every role added to the roster would
    // shift it. The scope is what must stay stable, not the value it lands on.
    const again = detectiveResults(resolve(game, "drunk-det")).find(
      (event) => event.scopeId === id("p0"),
    );
    expect((again!.payload as EventPayloads["detective.result"]).role).toBe(fakeRole);
  });

  test("can also roll inconclusive, never a wrong role", () => {
    const game = makeState(
      ["drunk", "detective", "villager"],
      { p0: { "detective.investigate": { targetId: id("p2") } } },
      { p0: { perceivedRole: "detective" } },
    );
    const transition = resolve(game, "seed");
    const results = detectiveResults(transition);
    expect(results).toHaveLength(1);
    const payload = results[0]!.payload as EventPayloads["detective.result"];
    expect(payload.targetId).toBe(id("p2"));
    expect(payload.role).toBeNull();
  });

  test("travels to the target's house and can die there", () => {
    const game = makeState(
      ["werewolf", "drunk", "villager"],
      {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "detective.investigate": { targetId: id("p2") } },
      },
      { p1: { perceivedRole: "detective" } },
    );
    const transition = resolve(game);
    expect(deadPlayerIds(transition)).toEqual(["p1", "p2"]);
    // The dead Drunk still saw what it saw.
    expect(detectiveResults(transition)).toHaveLength(1);
  });
});

describe("determinism", () => {
  test("a game containing neither role resolves identically to before for a fixed seed", () => {
    // Pinned pre-existing outcome: seed "seed" makes the hunter repel and kill
    // a wolf, so the pinned death list is a regression canary.
    const transition = resolve(
      makeState(["werewolf", "werewolf", "hunter", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
      }),
      "seed",
    );
    expect(deadPlayerIds(transition)).toEqual(["p0"]);
  });

  test("the two new scopes are the only randomness added: a detective shifts no existing draw", () => {
    const without = resolve(
      makeState(["werewolf", "werewolf", "hunter", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
      }),
      "seed",
    );
    const withDetective = resolve(
      makeState(["werewolf", "werewolf", "hunter", "villager", "detective"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
        p4: { "detective.investigate": { targetId: id("p3") } },
      }),
      "seed",
    );
    expect(deadPlayerIds(withDetective)).toEqual(["p0"]);
    // The only difference is the one added detective.result event.
    expect(withDetective.events.filter((event) => event.kind !== "detective.result")).toEqual(
      without.events,
    );
    // Pinned by the seed: this night's investigation is inconclusive.
    expect(withDetective.events).toContainEqual({
      kind: "detective.result",
      scope: "player",
      scopeId: id("p4"),
      payload: { targetId: id("p3"), role: null },
    });
  });

  test("a Drunk-Detective's fake roll lives on its own scope and shifts nothing else", () => {
    const transition = resolve(
      makeState(
        ["werewolf", "werewolf", "hunter", "drunk", "villager"],
        {
          p0: { "wolf.attack": { targetId: id("p2") } },
          p1: { "wolf.attack": { targetId: id("p2") } },
          p3: { "detective.investigate": { targetId: id("p4") } },
        },
        { p3: { perceivedRole: "detective" } },
      ),
      "seed",
    );
    expect(deadPlayerIds(transition)).toEqual(["p0"]);
    // Pinned by the seed: this night's fake investigation is inconclusive.
    expect(transition.events).toContainEqual({
      kind: "detective.result",
      scope: "player",
      scopeId: id("p3"),
      payload: { targetId: id("p4"), role: null },
    });
  });
});
