import { describe, expect, test } from "bun:test";
import type { EventPayloads, UserId } from "@werewolf/protocol";
import { applyCommand } from "../commands/apply.ts";
import { validateCommand } from "../commands/validate.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import { SeededRng } from "../rng/rng.ts";
import type { DomainTransition, GameState, PlayerState, VictoryResult } from "../state.ts";
import { resolveNight } from "./night.ts";
import { applyLoverRider, checkVictory } from "./victory.ts";
import { resolveDayVote } from "./vote.ts";

const id = (value: string) => value as PlayerState["id"];

interface PlayerSpec {
  role: PlayerState["role"];
  status?: PlayerState["status"];
  roleState?: unknown;
  actions?: Record<string, unknown>;
  vote?: { type: "player"; targetId: UserId } | { type: "abstain" };
}

function makeState(
  specs: PlayerSpec[],
  opts: {
    day?: number;
    phase?: "night" | "voting";
    phaseId?: number;
    nightsWithoutElimination?: number;
  } = {},
): GameState {
  const day = opts.day ?? 1;
  const phase = opts.phase ?? "night";
  const phaseId = opts.phaseId ?? 1;
  const players = Object.fromEntries(
    specs.map((spec, index) => {
      const playerId = id(`p${index}`);
      return [
        playerId,
        {
          id: playerId,
          status: spec.status ?? "alive",
          originalRole: spec.role,
          role: spec.role,
          faction:
            spec.role === "werewolf" || spec.role === "alpha_wolf"
              ? "wolves"
              : spec.role === "serial_killer"
                ? "serial_killer"
                : spec.role === "veteran"
                  ? "veteran"
                  : "village",
          roleState: spec.roleState ?? {},
          phaseState: {
            phaseId,
            ...(spec.actions ? { actions: spec.actions } : {}),
            ...(spec.vote ? { vote: spec.vote } : {}),
          },
        },
      ];
    }),
  );
  return {
    id: id("g") as unknown as GameState["id"],
    ownerUserId: id("p0"),
    status: "running",
    day,
    phase: { id: phaseId as never, type: phase, startedAt: 0, endsAt: 100 },
    players,
    settings: { discussionDurationMs: 10, votingDurationMs: 10, nightDurationMs: 10 },
    balanceVersion: 1,
    nightsWithoutElimination: opts.nightsWithoutElimination ?? 0,
    winner: null,
    version: 1,
  } as unknown as GameState;
}

function resolveNightOk(state: GameState, seed = "seed"): DomainTransition {
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

function auditDeaths(transition: DomainTransition): EventPayloads["audit.night"]["deaths"] {
  const event = transition.events.find((candidate) => candidate.kind === "audit.night");
  if (!event) return [];
  return (event.payload as EventPayloads["audit.night"]).deaths;
}

function setLink(game: GameState, actorId: string, targetIds: [string, string]): GameState {
  const result = applyCommand(
    game,
    id(actorId),
    {
      commandId: "c1",
      phaseId: game.phase!.id,
      type: "night.action.set",
      payload: { action: "cupid.link", targetIds: [id(targetIds[0]), id(targetIds[1])] },
    },
    { now: 1 },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  const patch = result.transition.playerPatches[0]!;
  return {
    ...game,
    players: {
      ...game.players,
      [patch.playerId]: { ...game.players[patch.playerId]!, ...patch.changes },
    },
  };
}

describe("cupid available actions", () => {
  test("cupid.link is offered on night 1 only, and not on night 2", () => {
    const night1 = makeState(
      [{ role: "cupid", roleState: { linked: null } }, { role: "villager" }, { role: "villager" }],
      { day: 1 },
    );
    const actions1 = getAvailableActions(night1, id("p0"));
    expect(actions1.some((action) => action.id === "cupid.link")).toBe(true);

    const night2 = makeState(
      [{ role: "cupid", roleState: { linked: null } }, { role: "villager" }, { role: "villager" }],
      { day: 2 },
    );
    const actions2 = getAvailableActions(night2, id("p0"));
    expect(actions2.some((action) => action.id === "cupid.link")).toBe(false);
  });

  test("the cupid appears in their own target list", () => {
    const state = makeState(
      [{ role: "cupid", roleState: { linked: null } }, { role: "villager" }, { role: "villager" }],
      { day: 1 },
    );
    const action = getAvailableActions(state, id("p0")).find((a) => a.id === "cupid.link");
    expect(action).toBeDefined();
    if (action?.type !== "targets") throw new Error("expected a targets action");
    expect(action.count).toBe(2);
    expect(action.targets.map((t) => t.userId)).toContain(id("p0"));
  });
});

describe("cupid link validation", () => {
  test("linking two players stores the pair and emits player.linked to each", () => {
    let state = makeState([
      { role: "cupid", roleState: { linked: null } },
      { role: "villager" },
      { role: "villager" },
      { role: "werewolf" },
    ]);
    state = setLink(state, "p0", ["p1", "p2"]);
    const transition = resolveNightOk(state);
    expect(transition.playerPatches).toContainEqual({
      playerId: id("p0"),
      changes: { roleState: { linked: [id("p1"), id("p2")] } },
    });
    expect(transition.events).toContainEqual({
      kind: "player.linked",
      scope: "player",
      scopeId: id("p1"),
      payload: { partnerId: id("p2") },
    });
    expect(transition.events).toContainEqual({
      kind: "player.linked",
      scope: "player",
      scopeId: id("p2"),
      payload: { partnerId: id("p1") },
    });
  });

  test("a link naming the same player twice is INVALID_TARGET", () => {
    const state = makeState([
      { role: "cupid", roleState: { linked: null } },
      { role: "villager" },
      { role: "villager" },
    ]);
    const result = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: state.phase!.id,
        type: "night.action.set",
        payload: { action: "cupid.link", targetIds: [id("p1"), id("p1")] },
      },
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("a link naming a dead player is INVALID_TARGET", () => {
    const state = makeState([
      { role: "cupid", roleState: { linked: null } },
      { role: "villager", status: "dead" },
      { role: "villager" },
    ]);
    const result = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: state.phase!.id,
        type: "night.action.set",
        payload: { action: "cupid.link", targetIds: [id("p1"), id("p2")] },
      },
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("a second link attempt is ACTION_NOT_AVAILABLE", () => {
    const state = makeState([
      { role: "cupid", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "villager" },
      { role: "villager" },
    ]);
    const result = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: state.phase!.id,
        type: "night.action.set",
        payload: { action: "cupid.link", targetIds: [id("p1"), id("p2")] },
      },
      { now: 1 },
    );
    expect(result).toEqual({ code: "ACTION_NOT_AVAILABLE" });
  });
});

describe("cupid link kills", () => {
  test("one lover killed at night kills the other, with audit cause lover_link", () => {
    const state = makeState([
      { role: "cupid", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "villager" },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    const transition = resolveNightOk(state);
    expect(deadPlayerIds(transition)).toEqual(["p1", "p2"]);
    expect(auditDeaths(transition)).toContainEqual({ playerId: id("p2"), cause: "lover_link" });
  });

  test("one lover lynched by day kills the other, and player.eliminated fires for both", () => {
    const state = makeState(
      [
        { role: "cupid", roleState: { linked: [id("p1"), id("p2")] } },
        { role: "villager", vote: { type: "player", targetId: id("p1") } },
        { role: "villager", vote: { type: "player", targetId: id("p1") } },
        { role: "werewolf" },
      ],
      { phase: "voting" },
    );
    const result = resolveDayVote(state);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const eliminated = result.transition.events.filter(
      (event) => event.kind === "player.eliminated",
    );
    expect(
      eliminated
        .map((event) => String((event.payload as EventPayloads["player.eliminated"]).playerId))
        .sort(),
    ).toEqual(["p1", "p2"]);
    expect(
      result.transition.playerPatches.some(
        (patch) => patch.playerId === id("p2") && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });

  test("both lovers dying to the same attack does not double-add or throw", () => {
    // The harlot lover visits the other lover's house, so both stand in the
    // house the pack attacks and both die to the same attack.
    const state = makeState([
      { role: "cupid", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "villager" },
      { role: "harlot", actions: { "harlot.visit": { targetId: id("p1") } } },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    const transition = resolveNightOk(state);
    expect(deadPlayerIds(transition)).toEqual(["p1", "p2"]);
    // Each player appears exactly once in the death patches.
    const deathPatches = transition.playerPatches.filter(
      (patch) => patch.changes.status === "dead",
    );
    expect(deathPatches).toHaveLength(2);
  });

  test("the link still kills after the cupid themselves is dead", () => {
    const state = makeState([
      { role: "cupid", status: "dead", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "villager" },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    const transition = resolveNightOk(state);
    expect(deadPlayerIds(transition)).toEqual(["p1", "p2"]);
    expect(auditDeaths(transition)).toContainEqual({ playerId: id("p2"), cause: "lover_link" });
  });

  test("a cupid who linked themselves to someone dies when that partner dies", () => {
    const state = makeState([
      { role: "cupid", roleState: { linked: [id("p0"), id("p1")] } },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    const transition = resolveNightOk(state);
    expect(deadPlayerIds(transition)).toEqual(["p0", "p1"]);
    expect(auditDeaths(transition)).toContainEqual({ playerId: id("p0"), cause: "lover_link" });
  });
});

describe("cupid victory rider", () => {
  test("a wolf lover and a village lover: wolves win, the village lover is carried in", () => {
    // The cupid is dead too, so the only living player is the wolf lover.
    const state = makeState([
      { role: "cupid", status: "dead", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "werewolf" },
      { role: "villager", status: "dead" },
    ]);
    const result = checkVictory(state);
    expect(result).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: [id("p1"), id("p2")],
      reason: "village_eliminated",
    });
  });

  test("the rider works when the carried lover is already dead", () => {
    const state = makeState([
      { role: "cupid", status: "dead", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "werewolf" },
      { role: "villager", status: "dead" },
    ]);
    const result = checkVictory(state);
    expect(result?.winningPlayers).toContain(id("p2"));
    expect(result?.winningFactions).toEqual(["wolves"]);
  });

  test("no link formed means no rider and no extra deaths", () => {
    // No extra deaths at night: only the attacked lover dies.
    const state = makeState([
      { role: "cupid", roleState: { linked: null } },
      { role: "villager" },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    const transition = resolveNightOk(state);
    expect(deadPlayerIds(transition)).toEqual(["p1"]);
    expect(auditDeaths(transition)).toEqual([{ playerId: id("p1"), cause: "wolf_attack" }]);

    // No rider: a finished game with no link carries nobody in.
    const finished = makeState([
      { role: "cupid", status: "dead", roleState: { linked: null } },
      { role: "werewolf" },
      { role: "villager", status: "dead" },
    ]);
    const result = checkVictory(finished);
    expect(result).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: [id("p1")],
      reason: "village_eliminated",
    });
  });
});

describe("Drunk-Cupid", () => {
  test("a Drunk-Cupid is offered cupid.link on night 1", () => {
    const state = makeState([
      { role: "drunk", roleState: { perceivedRole: "cupid" } },
      { role: "villager" },
      { role: "villager" },
    ]);
    const actions = getAvailableActions(state, id("p0"));
    expect(actions.some((action) => action.id === "cupid.link")).toBe(true);
  });

  test("a Drunk-Cupid linking two other players forms no link", () => {
    let state = makeState([
      { role: "drunk", roleState: { perceivedRole: "cupid" } },
      { role: "villager" },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    state = setLink(state, "p0", ["p1", "p2"]);
    const transition = resolveNightOk(state);
    // No pair is stored anywhere.
    expect(transition.playerPatches).not.toContainEqual({
      playerId: id("p0"),
      changes: { roleState: { linked: [id("p1"), id("p2")] } },
    });
    // No player.linked event reaches anyone.
    expect(transition.events.filter((e) => e.kind === "player.linked")).toEqual([]);
    // The partner does not die when the other lover does.
    expect(deadPlayerIds(transition)).toEqual(["p1"]);
  });

  test("a Drunk-Cupid linking themselves and X is told they are linked, but no real link forms", () => {
    // The Drunk-Cupid picks themselves and X; the pack attacks the Drunk.
    let state = makeState([
      { role: "drunk", roleState: { perceivedRole: "cupid" } },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p0") } } },
    ]);
    state = setLink(state, "p0", ["p0", "p1"]);
    const transition = resolveNightOk(state);
    // The Drunk-Cupid is told they are linked to the other pick.
    expect(transition.events).toContainEqual({
      kind: "player.linked",
      scope: "player",
      scopeId: id("p0"),
      payload: { partnerId: id("p1") },
    });
    // The other pick receives nothing.
    expect(
      transition.events.filter((e) => e.kind === "player.linked" && e.scopeId === id("p1")),
    ).toEqual([]);
    // No real link: X does not die when the Drunk dies.
    expect(deadPlayerIds(transition)).toEqual(["p0"]);

    // Nor the reverse: when X dies, the Drunk-Cupid does not die from the link.
    let reverse = makeState([
      { role: "drunk", roleState: { perceivedRole: "cupid" } },
      { role: "villager" },
      { role: "werewolf", actions: { "wolf.attack": { targetId: id("p1") } } },
    ]);
    reverse = setLink(reverse, "p0", ["p0", "p1"]);
    const reverseTransition = resolveNightOk(reverse);
    expect(deadPlayerIds(reverseTransition)).toEqual(["p1"]);
  });

  test("a real Cupid in the same game is unaffected by a Drunk-Cupid", () => {
    let state = makeState([
      { role: "cupid", roleState: { linked: null } },
      { role: "drunk", roleState: { perceivedRole: "cupid" } },
      { role: "villager" },
      { role: "villager" },
      { role: "werewolf" },
    ]);
    // The real cupid and the drunk-cupid both link p2 and p3.
    state = setLink(state, "p0", ["p2", "p3"]);
    state = setLink(state, "p1", ["p2", "p3"]);
    const transition = resolveNightOk(state);
    // The real cupid's link forms.
    expect(transition.playerPatches).toContainEqual({
      playerId: id("p0"),
      changes: { roleState: { linked: [id("p2"), id("p3")] } },
    });
    // The drunk-cupid's link does not.
    expect(transition.playerPatches).not.toContainEqual({
      playerId: id("p1"),
      changes: { roleState: { linked: [id("p2"), id("p3")] } },
    });
    // The real cupid's lovers are told who the other is.
    expect(transition.events).toContainEqual({
      kind: "player.linked",
      scope: "player",
      scopeId: id("p2"),
      payload: { partnerId: id("p3") },
    });
    expect(transition.events).toContainEqual({
      kind: "player.linked",
      scope: "player",
      scopeId: id("p3"),
      payload: { partnerId: id("p2") },
    });
  });
});

describe("veteran-lynch lover rider", () => {
  test("a Veteran who is a lover is lynched: the partner is carried into the win", () => {
    const state = makeState(
      [
        { role: "cupid", roleState: { linked: [id("p1"), id("p2")] } },
        { role: "veteran", vote: { type: "player", targetId: id("p1") } },
        { role: "villager", vote: { type: "player", targetId: id("p1") } },
        { role: "werewolf" },
      ],
      { phase: "voting" },
    );
    const result = resolveDayVote(state);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const winner = result.transition.gamePatch?.winner;
    expect(winner).toMatchObject({
      winningFactions: ["veteran"],
      reason: "veteran_lynched",
    });
    expect(winner?.winningPlayers).toContain(id("p2"));
    // The partner is also eliminated in that transition.
    expect(
      result.transition.playerPatches.some(
        (patch) => patch.playerId === id("p2") && patch.changes.status === "dead",
      ),
    ).toBe(true);
  });

  test("applyLoverRider applied twice produces the same winningPlayers as once", () => {
    const state = makeState([
      { role: "cupid", roleState: { linked: [id("p1"), id("p2")] } },
      { role: "veteran" },
      { role: "villager" },
    ]);
    const base: VictoryResult = {
      winningFactions: ["veteran"],
      winningPlayers: [id("p1")],
      reason: "veteran_lynched",
    };
    const once = applyLoverRider(state, base);
    const twice = applyLoverRider(state, once);
    expect(twice.winningPlayers).toEqual(once.winningPlayers);
  });
});
