import { describe, expect, test } from "bun:test";
import type { AvailableAction, GameEvent } from "@werewolf/protocol";
import { WOLF_ROLE_IDS } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import { getLegalCommands, getSpeakableChannels } from "../projection/legal-commands.ts";
import { canViewEvent } from "../projection/permissions.ts";
import { projectSnapshot } from "../projection/snapshot.ts";
import { resolveNight } from "../resolution/night.ts";
import { startGame } from "../resolution/phase.ts";
import { checkVictory } from "../resolution/victory.ts";
import { SeededRng } from "../rng/rng.ts";
import { isPackMember, WOLF_CHAT_ROLES } from "../roles/registry.ts";
import type { DomainTransition, GameState, PlayerState } from "../state.ts";

const id = (value: string) => value as PlayerState["id"];

function makeState(
  roles: PlayerState["role"][],
  actions: Record<string, Record<string, unknown>> = {},
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
            role === "werewolf" || role === "alpha_wolf" || role === "cub" || role === "sorcerer"
              ? "wolves"
              : role === "serial_killer"
                ? "serial_killer"
                : role === "veteran"
                  ? "veteran"
                  : "village",
          roleState: {},
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

function resolve(state: GameState, seed = "seed") {
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

function targetList(action: AvailableAction | undefined): { userId: string; enabled: boolean }[] {
  return action?.type === "target" ? action.targets : [];
}

/** The deal-time pack announcement, from a real startGame. Returns the sorcerer's
 * seat and the start transition for an 8-player game whose composition contains
 * one. */
function startWithSorcerer(): { sorcererId: PlayerState["id"]; transition: DomainTransition } {
  for (let seed = 0; seed < 500; seed += 1) {
    const lobby = makeLobby(8);
    const result = startGame(lobby, { now: 100, seed: `sorcerer-${seed}` });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const sorcerer = result.transition.playerPatches.find(
      (patch) => patch.changes.role === "sorcerer",
    );
    if (sorcerer) return { sorcererId: sorcerer.playerId, transition: result.transition };
  }
  throw new Error("no 8-player composition deals a sorcerer");
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
    // Written against the full role pool, which is now the "chaos" preset; the
    // default ("classic") never deals a Sorcerer.
    settings: {
      discussionDurationMs: 10,
      votingDurationMs: 20,
      nightDurationMs: 30,
      preset: "chaos",
    },
    balanceVersion: 1,
    nightsWithoutElimination: 0,
    winner: null,
    version: 1,
  };
}

describe("the Sorcerer", () => {
  test("is a pack member for neither the attack offer nor its validation", () => {
    const state = makeState(["sorcerer", "werewolf", "villager"]);
    expect(isPackMember(state.players[id("p0")]!)).toBe(false);
    const actions = getAvailableActions(state, id("p0"));
    expect(actions.some((action) => action.id === "wolf.attack")).toBe(false);
    expect(actions).toContainEqual({
      id: "sorcerer.divine",
      type: "target",
      targets: [
        { userId: id("p1"), enabled: true },
        { userId: id("p2"), enabled: true },
      ],
    });
    const attack = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "night.action.set",
        payload: { action: "wolf.attack", targetId: id("p1") },
      },
      { now: 1 },
    );
    expect(attack).toEqual({ code: "ACTION_NOT_AVAILABLE" });
  });

  test("its stored wolf.attack is not counted in the wolf ballot", () => {
    const night = makeState(["werewolf", "sorcerer", "villager", "villager"], {
      p0: { "wolf.attack": { targetId: id("p2") } },
      // A stale or smuggled intent must not become a seat in the ballot.
      p1: { "wolf.attack": { targetId: id("p3") } },
    });
    const transition = resolve(night);
    // If the sorcerer's vote counted, the ballot would tie and nobody would die.
    expect(deadPlayerIds(transition)).toEqual(["p2"]);
    const audit = transition.events.find((candidate) => candidate.kind === "audit.night");
    expect(audit?.payload).toMatchObject({
      wolfVotes: [{ playerId: id("p0"), targetId: id("p2") }],
    });
  });

  test("may not read or write the wolves channel, and wolf-scope events are invisible", () => {
    const state = makeState(["sorcerer", "werewolf", "villager"]);
    const write = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "chat.send",
        payload: { channel: "wolves", text: "hello" },
      },
      { now: 1 },
    );
    expect(write).toEqual({ code: "CHANNEL_NOT_AVAILABLE" });
    expect(getSpeakableChannels(state, id("p0"), 1)).toEqual([]);
    const memberEvent: GameEvent = {
      id: 1 as GameEvent["id"],
      kind: "wolves.member_joined",
      scope: "faction",
      scopeId: "wolves",
      createdAt: 0,
      payload: { playerId: id("p1") },
    };
    expect(canViewEvent(memberEvent, id("p0"), state)).toBe(false);
    const chatEvent: GameEvent = {
      id: 2 as GameEvent["id"],
      kind: "chat.message",
      scope: "faction",
      scopeId: "wolves",
      createdAt: 0,
      payload: { channel: "wolves", text: "psst" },
    };
    expect(canViewEvent(chatEvent, id("p0"), state)).toBe(false);
    // The viewer snapshot must not offer the wolves channel either: the client
    // renders a wolf-chat tab from it, and the sorcerer cannot use it.
    expect(projectSnapshot(state, id("p0")).availableChannels).not.toContain("wolves");
    // By day the sorcerer speaks on the public channel like anyone else.
    const day = makeState(["sorcerer", "werewolf", "villager"]);
    day.phase = { id: 2 as never, type: "discussion", startedAt: 0, endsAt: 100 };
    expect(getSpeakableChannels(day, id("p0"), 1)).toEqual(["public"]);
  });

  test("is told no pack at deal time, and the pack is told nothing about them", () => {
    const { sorcererId, transition } = startWithSorcerer();
    const joined = transition.events.filter((event) => event.kind === "wolves.member_joined");
    expect(joined.length).toBeGreaterThan(0);
    for (const event of joined) {
      expect(event.scopeId).not.toBe(sorcererId);
      expect((event.payload as { playerId: string }).playerId).not.toBe(sorcererId);
    }
  });

  test("the pack can attack them: an enabled wolf.attack target that dies", () => {
    const state = makeState(["werewolf", "sorcerer", "villager"]);
    const attack = getAvailableActions(state, id("p0")).find(
      (action) => action.id === "wolf.attack",
    );
    expect(targetList(attack)).toContainEqual({ userId: id("p1"), enabled: true });
    const legal = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "night.action.set",
        payload: { action: "wolf.attack", targetId: id("p1") },
      },
      { now: 1 },
    );
    expect(legal).toBeNull();
    const night = makeState(["werewolf", "sorcerer", "villager"], {
      p0: { "wolf.attack": { targetId: id("p1") } },
    });
    const transition = resolve(night);
    expect(deadPlayerIds(transition)).toEqual(["p1"]);
    const audit = transition.events.find((candidate) => candidate.kind === "audit.night");
    expect(audit?.payload).toMatchObject({
      deaths: [{ playerId: id("p1"), cause: "wolf_attack" }],
    });
  });

  test("does not travel with the pack: stays home while the pack hunts elsewhere", () => {
    // The harlot visits the sorcerer's house. If the sorcerer had gathered with
    // the pack at the balloted target's house, the house would be empty and the
    // harlot would survive; exposure proves the sorcerer is home.
    const night = makeState(["werewolf", "sorcerer", "harlot", "villager"], {
      p0: { "wolf.attack": { targetId: id("p3") } },
      p2: { "harlot.visit": { targetId: id("p1") } },
    });
    const transition = resolve(night);
    expect(deadPlayerIds(transition)).toEqual(["p2", "p3"]);
    expect(transition.playerPatches).not.toContainEqual({
      playerId: id("p1"),
      changes: { status: "dead" },
    });
  });

  test("divines wolf-faction players as wolves and villagers as not, never an exact role", () => {
    const cases: {
      label: string;
      roles: PlayerState["role"][];
      target: string;
      isWolf: boolean;
    }[] = [
      {
        label: "a werewolf",
        roles: ["sorcerer", "werewolf", "villager"],
        target: "p1",
        isWolf: true,
      },
      { label: "a cub", roles: ["sorcerer", "cub", "villager"], target: "p1", isWolf: true },
      {
        label: "an alpha wolf",
        roles: ["sorcerer", "alpha_wolf", "villager"],
        target: "p1",
        isWolf: true,
      },
      {
        label: "another sorcerer",
        roles: ["sorcerer", "sorcerer", "villager"],
        target: "p1",
        isWolf: true,
      },
      {
        label: "a villager",
        roles: ["sorcerer", "villager", "villager"],
        target: "p1",
        isWolf: false,
      },
    ];
    for (const { label, roles, target, isWolf } of cases) {
      const night = makeState(roles, {
        p0: { "sorcerer.divine": { targetId: id(target) } },
      });
      const transition = resolve(night);
      expect(transition.events, label).toContainEqual({
        kind: "sorcerer.result",
        scope: "player",
        scopeId: id("p0"),
        payload: { targetId: id(target), isWolf },
      });
      expect(
        transition.events.some(
          (event) => event.kind === "sorcerer.result" && "role" in (event.payload as object),
        ),
      ).toBe(false);
    }
  });

  test("may not divine themselves", () => {
    const state = makeState(["sorcerer", "villager"]);
    const result = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: 1 as never,
        type: "night.action.set",
        payload: { action: "sorcerer.divine", targetId: id("p0") },
      },
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
    // The offer lists other players only.
    const divine = getAvailableActions(state, id("p0")).find(
      (action) => action.id === "sorcerer.divine",
    );
    expect(targetList(divine).map((target) => target.userId)).not.toContain(id("p0"));
  });

  test("wins when the wolves win, even though it is no pack member", () => {
    const state = makeState(["werewolf", "sorcerer", "villager"]);
    state.players[id("p2")]!.status = "dead";
    expect(checkVictory(state)).toEqual({
      winningFactions: ["wolves"],
      winningPlayers: [id("p0"), id("p1")],
      reason: "village_eliminated",
    });
  });

  test("is revealed as a wolf: it is in WOLF_ROLE_IDS", () => {
    expect(WOLF_ROLE_IDS).toContain("sorcerer");
  });

  test("its scry is enumerated as a legal command for bots", () => {
    const state = makeState(["sorcerer", "villager", "villager"]);
    const divines = getLegalCommands(state, id("p0"), 1)
      .filter(
        (command): command is Extract<typeof command, { type: "night.action.set" }> =>
          command.type === "night.action.set",
      )
      .map((command) =>
        command.payload.action === "sorcerer.divine" ? command.payload.targetId : null,
      )
      .filter((targetId): targetId is PlayerState["id"] => targetId !== null);
    expect(divines.sort()).toEqual([id("p1"), id("p2")]);
  });
});

describe("the pack still behaves as the pack (regression)", () => {
  test("an ordinary werewolf keeps the attack, the ballot, wolf chat, immunity and travel", () => {
    // Attack offered.
    const offered = getAvailableActions(makeState(["werewolf", "villager"]), id("p0"));
    expect(offered).toContainEqual({
      id: "wolf.attack",
      type: "target",
      targets: [{ userId: id("p1"), enabled: true }],
    });
    // Vote counted: two votes for different targets tie the ballot.
    const tie = resolve(
      makeState(["werewolf", "werewolf", "villager", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p3") } },
      }),
    );
    expect(deadPlayerIds(tie)).toEqual([]);
    // Wolf chat.
    expect(WOLF_CHAT_ROLES.has("werewolf")).toBe(true);
    expect(
      validateCommand(
        makeState(["werewolf", "villager"]),
        id("p0"),
        {
          commandId: "c1",
          phaseId: 1 as never,
          type: "chat.send",
          payload: { channel: "wolves", text: "hello" },
        },
        { now: 1 },
      ),
    ).toBeNull();
    // The snapshot still offers the wolves channel to a real wolf.
    expect(
      projectSnapshot(makeState(["werewolf", "villager"]), id("p0")).availableChannels,
    ).toContain("wolves");
    // Immune to the pack's own attack while standing in the attacked house.
    const immune = resolve(
      makeState(["werewolf", "werewolf", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
      }),
    );
    expect(deadPlayerIds(immune)).toEqual(["p2"]);
    // Travels to the balloted house: a harlot visiting the wolf's house finds
    // it empty when the pack hunts elsewhere.
    const travel = resolve(
      makeState(["werewolf", "harlot", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "harlot.visit": { targetId: id("p0") } },
      }),
    );
    expect(deadPlayerIds(travel)).toEqual(["p2"]);
  });

  test("the cub and the alpha keep the attack, the ballot, wolf chat, immunity and travel", () => {
    for (const role of ["cub", "alpha_wolf"] as const) {
      const offered = getAvailableActions(makeState([role, "villager"]), id("p0"));
      expect(offered, role).toContainEqual({
        id: "wolf.attack",
        type: "target",
        targets: [{ userId: id("p1"), enabled: true }],
      });
      const tie = resolve(
        makeState([role, "werewolf", "villager", "villager"], {
          p0: { "wolf.attack": { targetId: id("p2") } },
          p1: { "wolf.attack": { targetId: id("p3") } },
        }),
      );
      expect(deadPlayerIds(tie), role).toEqual([]);
      expect(WOLF_CHAT_ROLES.has(role), role).toBe(true);
      const immune = resolve(
        makeState([role, "werewolf", "villager"], {
          p0: { "wolf.attack": { targetId: id("p2") } },
          p1: { "wolf.attack": { targetId: id("p2") } },
        }),
      );
      expect(deadPlayerIds(immune), role).toEqual(["p2"]);
      const travel = resolve(
        makeState([role, "harlot", "villager"], {
          p0: { "wolf.attack": { targetId: id("p2") } },
          p1: { "harlot.visit": { targetId: id("p0") } },
        }),
      );
      expect(deadPlayerIds(travel), role).toEqual(["p2"]);
    }
  });

  test("the scry consumes no randomness: the same seed reproduces the same night", () => {
    // Seed "seed" makes the hunter repel and kill a wolf. With a sorcerer
    // scrying on top, every roll must land identically — the retaliation pool
    // is the pack (werewolves only), and the scry derives nothing.
    const withoutSorcerer = resolve(
      makeState(["werewolf", "werewolf", "hunter", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
      }),
      "seed",
    );
    expect(deadPlayerIds(withoutSorcerer)).toEqual(["p0"]);
    const withSorcerer = resolve(
      makeState(["werewolf", "werewolf", "hunter", "sorcerer", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
        p3: { "sorcerer.divine": { targetId: id("p4") } },
      }),
      "seed",
    );
    expect(deadPlayerIds(withSorcerer)).toEqual(["p0"]);
    expect(withSorcerer.events).toContainEqual({
      kind: "sorcerer.result",
      scope: "player",
      scopeId: id("p3"),
      payload: { targetId: id("p4"), isWolf: false },
    });
    // And the same state resolves identically twice over.
    const again = resolve(
      makeState(["werewolf", "werewolf", "hunter", "sorcerer", "villager"], {
        p0: { "wolf.attack": { targetId: id("p2") } },
        p1: { "wolf.attack": { targetId: id("p2") } },
        p3: { "sorcerer.divine": { targetId: id("p4") } },
      }),
      "seed",
    );
    expect(again.events).toEqual(withSorcerer.events);
  });
});
