import { describe, expect, test } from "bun:test";
import type { UserId } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import { isValidComposition } from "../composer/constraints.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import { canViewEvent } from "../projection/permissions.ts";
import type { DomainTransition, GameState } from "../state.ts";
import { action, auditDeaths, deadPlayerIds, id, makeState, resolve } from "./night.test.ts";

// Seeds pinned so the 50/50 duel is deterministic: see the derive scope
// "night:<day>:lone_wolf:challenge".
const LONE_WOLF_WINS = "s2";
const ALPHA_WINS = "seed";

function patchFor(transition: DomainTransition, playerId: string) {
  return transition.playerPatches.find((patch) => String(patch.playerId) === playerId);
}

function eventsOfKind(transition: DomainTransition, kind: string) {
  return transition.events.filter((event) => event.kind === kind);
}

/** The pack attacks p3's house; the lone wolf searches the same house, so the
 * alpha is standing in it. */
function clashState() {
  return makeState(["lone_wolf", "alpha_wolf", "werewolf", "villager"], {
    p0: { "lone_wolf.search": { targetId: id("p3") } },
    p1: action("p3"),
    p2: action("p3"),
  });
}

describe("lone wolf clash", () => {
  test("searching the house the pack is attacking, with the alpha there, is a clash", () => {
    const transition = resolve(clashState(), LONE_WOLF_WINS);
    const result = eventsOfKind(transition, "lone_wolf.result")[0]!;
    expect((result.payload as { found: boolean }).found).toBe(true);
  });

  test("searching elsewhere is not a clash", () => {
    const transition = resolve(
      makeState(["lone_wolf", "alpha_wolf", "werewolf", "villager"], {
        p0: { "lone_wolf.search": { targetId: id("p2") } },
        p1: action("p3"),
        p2: action("p3"),
      }),
      LONE_WOLF_WINS,
    );
    const result = eventsOfKind(transition, "lone_wolf.result")[0]!;
    expect((result.payload as { found: boolean }).found).toBe(false);
  });

  test("the lone wolf wins: the alpha dies and the lone wolf ascends", () => {
    const transition = resolve(clashState(), LONE_WOLF_WINS);
    expect(deadPlayerIds(transition)).toContain("p1");
    expect(auditDeaths(transition).find((death) => String(death.playerId) === "p1")?.cause).toBe(
      "lone_wolf_clash",
    );
    const patch = patchFor(transition, "p0");
    expect(patch?.changes.role).toBe("alpha_wolf");
    expect(patch?.changes.faction).toBe("wolves");
    expect(
      eventsOfKind(transition, "wolves.member_joined").some(
        (event) => String((event.payload as { playerId: UserId }).playerId) === "p0",
      ),
    ).toBe(true);
  });

  test("the lone wolf loses: they die and the alpha lives", () => {
    const transition = resolve(clashState(), ALPHA_WINS);
    expect(deadPlayerIds(transition)).toContain("p0");
    expect(deadPlayerIds(transition)).not.toContain("p1");
    expect(patchFor(transition, "p0")?.changes.role).toBeUndefined();
  });

  test("the clash pre-empts the pack's attack on that house", () => {
    // p3's house is attacked and both duellists are standing in it. Only the
    // duel's loser dies from the duel; the pack's hit must not kill the winner.
    const transition = resolve(clashState(), LONE_WOLF_WINS);
    const dead = deadPlayerIds(transition);
    expect(dead).not.toContain("p0");
    expect(auditDeaths(transition).every((death) => String(death.playerId) !== "p0")).toBe(true);
  });

  test("a priest shielding the house does not prevent the clash", () => {
    const transition = resolve(
      makeState(["lone_wolf", "alpha_wolf", "werewolf", "priest"], {
        p0: { "lone_wolf.search": { targetId: id("p3") } },
        p1: action("p3"),
        p2: action("p3"),
        p3: { "priest.protect": { targetId: id("p3") } },
      }),
      LONE_WOLF_WINS,
    );
    expect(deadPlayerIds(transition)).toContain("p1");
  });

  test("the result reports found false when no alpha is in the searched house", () => {
    const transition = resolve(
      makeState(["lone_wolf", "werewolf", "werewolf", "villager"], {
        p0: { "lone_wolf.search": { targetId: id("p3") } },
        p1: action("p3"),
        p2: action("p3"),
      }),
      LONE_WOLF_WINS,
    );
    const result = eventsOfKind(transition, "lone_wolf.result")[0]!;
    expect((result.payload as { found: boolean }).found).toBe(false);
  });
});

describe("lone wolf is not one of the pack", () => {
  test("no wolf ballot, no wolf attack action", () => {
    const state = makeState(["lone_wolf", "werewolf", "werewolf", "villager"], {});
    const actions = getAvailableActions(state, id("p0")).map((entry) => entry.id);
    expect(actions).toContain("lone_wolf.search");
    expect(actions).not.toContain("wolf.attack");
    expect(
      validateCommand(
        state,
        id("p0"),
        {
          commandId: "c1",
          phaseId: state.phase!.id,
          type: "night.action.set",
          payload: { action: "wolf.attack", targetId: id("p3") },
        },
        { now: 0 },
      ),
    ).toEqual({ code: "ACTION_NOT_AVAILABLE" });
  });

  test("the pack can kill them", () => {
    const transition = resolve(
      makeState(["lone_wolf", "werewolf", "werewolf", "villager"], {
        p1: action("p0"),
        p2: action("p0"),
      }),
      ALPHA_WINS,
    );
    expect(deadPlayerIds(transition)).toContain("p0");
  });

  test("they may not search themselves", () => {
    const state = makeState(["lone_wolf", "alpha_wolf", "werewolf", "villager"], {});
    expect(
      validateCommand(
        state,
        id("p0"),
        {
          commandId: "c1",
          phaseId: state.phase!.id,
          type: "night.action.set",
          payload: { action: "lone_wolf.search", targetId: id("p0") },
        },
        { now: 0 },
      ),
    ).toEqual({ code: "INVALID_TARGET" });
  });

  test("an ascended lone wolf reads wolf chat only from their marker onward", () => {
    const transition = resolve(clashState(), LONE_WOLF_WINS);
    const state = clashState();
    const ascended: GameState = {
      ...state,
      players: {
        ...state.players,
        [id("p0")]: {
          ...state.players[id("p0")]!,
          role: "alpha_wolf",
          faction: "wolves",
          channelSince: { wolves: 50 as never },
        },
      },
    };
    const before = {
      id: 10 as never,
      kind: "chat.message" as const,
      scope: "faction" as const,
      scopeId: "wolves",
      createdAt: 0,
      payload: { channel: "wolves" as const, text: "before" },
    };
    const after = {
      ...before,
      id: 60 as never,
      payload: { channel: "wolves" as const, text: "after" },
    };
    expect(canViewEvent(before, id("p0"), ascended)).toBe(false);
    expect(canViewEvent(after, id("p0"), ascended)).toBe(true);
    expect(transition.playerPatches.length).toBeGreaterThan(0);
  });
});

describe("the alpha dying to somebody else", () => {
  test("the lone wolf converts to a plain werewolf in that same night resolution", () => {
    // The serial killer visits the alpha at home; the pack stays home too.
    const transition = resolve(
      makeState(["lone_wolf", "alpha_wolf", "serial_killer", "villager"], {
        p2: { "serial_killer.visit": { targetId: id("p1") } },
      }),
      ALPHA_WINS,
    );
    expect(deadPlayerIds(transition)).toContain("p1");
    const patch = patchFor(transition, "p0");
    expect(patch?.changes.role).toBe("werewolf");
    expect(patch?.changes.faction).toBe("wolves");
    const converted = eventsOfKind(transition, "player.converted")[0]!;
    expect((converted.payload as { cause: string }).cause).toBe("alpha_dead");
  });

  test("no conversion while the alpha is still alive", () => {
    const transition = resolve(
      makeState(["lone_wolf", "alpha_wolf", "werewolf", "villager"], {
        p1: action("p3"),
        p2: action("p3"),
      }),
      ALPHA_WINS,
    );
    expect(patchFor(transition, "p0")?.changes.role).toBeUndefined();
  });
});

describe("composition", () => {
  test("a composition containing lone_wolf without alpha_wolf is invalid", () => {
    const roles = [
      "lone_wolf",
      "werewolf",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
    ] as const;
    expect(isValidComposition(roles, 10)).toBe(false);
  });

  test("the same composition with an alpha is valid", () => {
    const roles = [
      "lone_wolf",
      "alpha_wolf",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
    ] as const;
    expect(isValidComposition(roles, 10)).toBe(true);
  });
});
