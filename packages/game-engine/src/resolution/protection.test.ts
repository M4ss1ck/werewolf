import { describe, expect, test } from "bun:test";
import type { UserId } from "@werewolf/protocol";
import { validateCommand } from "../commands/validate.ts";
import { getAvailableActions } from "../projection/available-actions.ts";
import type { DomainTransition, GameState } from "../state.ts";
import { action, auditDeaths, deadPlayerIds, id, makeState, resolve } from "./night.test.ts";

/** Apply a night transition to the state it was resolved from, so a test can
 * roll the game forward one night and inspect the next one. */
function applyTransition(state: GameState, transition: DomainTransition): GameState {
  const players = { ...state.players };
  for (const patch of transition.playerPatches)
    players[patch.playerId] = { ...players[patch.playerId]!, ...patch.changes };
  return {
    ...state,
    ...(transition.gamePatch ?? {}),
    players,
  };
}

function setRoleState(state: GameState, playerId: string, roleState: unknown): GameState {
  return {
    ...state,
    players: {
      ...state.players,
      [id(playerId)]: { ...state.players[id(playerId)]!, roleState },
    },
  };
}

function conversions(transition: DomainTransition): { playerId: string; cause: string }[] {
  // A conversion is a playerPatch that turns the player into a werewolf; the
  // cause is carried by the player.converted event, which does not name the
  // player, so pair the two up by the wolves.member_joined event.
  const convertedIds = transition.playerPatches
    .filter((patch) => patch.changes.role === "werewolf")
    .map((patch) => String(patch.playerId));
  const causes = transition.events
    .filter((event) => event.kind === "player.converted")
    .map((event) => (event.payload as { cause: string }).cause);
  return convertedIds.map((playerId, index) => ({ playerId, cause: causes[index] ?? "" }));
}

describe("priest shield", () => {
  test("a shielded player attacked by the wolves does not die", () => {
    const transition = resolve(
      makeState(["priest", "werewolf", "werewolf", "villager"], {
        p0: { "priest.protect": { targetId: id("p3") } },
        p1: action("p3"),
        p2: action("p3"),
      }),
    );
    expect(deadPlayerIds(transition)).toEqual([]);
  });

  test("a shielded player attacked by the serial killer does not die", () => {
    const transition = resolve(
      makeState(["priest", "serial_killer", "villager"], {
        p0: { "priest.protect": { targetId: id("p2") } },
        p1: { "serial_killer.visit": { targetId: id("p2") } },
      }),
    );
    expect(deadPlayerIds(transition)).toEqual([]);
  });

  test("a shielded CURSED player attacked by the wolves does not die AND does not convert", () => {
    const transition = resolve(
      makeState(["priest", "werewolf", "werewolf", "cursed"], {
        p0: { "priest.protect": { targetId: id("p3") } },
        p1: action("p3"),
        p2: action("p3"),
      }),
    );
    expect(deadPlayerIds(transition)).toEqual([]);
    expect(conversions(transition)).toEqual([]);
  });

  test("the priest may protect themselves", () => {
    const transition = resolve(
      makeState(["priest", "werewolf", "werewolf"], {
        p0: { "priest.protect": { targetId: id("p0") } },
        p1: action("p0"),
        p2: action("p0"),
      }),
    );
    expect(deadPlayerIds(transition)).toEqual([]);
  });

  test("protecting the same player two nights running is INVALID_TARGET and the target is offered disabled", () => {
    const state = setRoleState(makeState(["priest", "villager", "villager"]), "p0", {
      lastProtectedId: id("p1"),
    });
    const result = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: state.phase!.id,
        type: "night.action.set",
        payload: { action: "priest.protect", targetId: id("p1") },
      } as never,
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
    const protect = getAvailableActions(state, id("p0")).find((a) => a.id === "priest.protect");
    expect(protect?.type).toBe("target");
    if (protect?.type === "target") {
      const p1 = protect.targets.find((t) => t.userId === id("p1"));
      expect(p1?.enabled).toBe(false);
    }
  });

  test("protecting a DIFFERENT player on the second night is fine, and the first player becomes selectable again on the third", () => {
    // Night 2: lastProtectedId is p1, so protecting p2 is fine.
    const night2 = setRoleState(makeState(["priest", "villager", "villager"]), "p0", {
      lastProtectedId: id("p1"),
    });
    const valid = validateCommand(
      night2,
      id("p0"),
      {
        commandId: "c1",
        phaseId: night2.phase!.id,
        type: "night.action.set",
        payload: { action: "priest.protect", targetId: id("p2") },
      } as never,
      { now: 1 },
    );
    expect(valid).toBeNull();
    // Night 3: lastProtectedId is p2, so p1 is selectable again.
    const night3 = setRoleState(makeState(["priest", "villager", "villager"]), "p0", {
      lastProtectedId: id("p2"),
    });
    const protect = getAvailableActions(night3, id("p0")).find((a) => a.id === "priest.protect");
    expect(protect?.type).toBe("target");
    if (protect?.type === "target") {
      expect(protect.targets.find((t) => t.userId === id("p1"))?.enabled).toBe(true);
    }
  });

  test("lastProtectedId rolls forward correctly across nights", () => {
    // Night 1: the priest protects p1, so the patch rolls lastProtectedId to p1.
    const protectedState = makeState(["priest", "villager", "villager"], {
      p0: { "priest.protect": { targetId: id("p1") } },
    });
    const afterProtected = applyTransition(protectedState, resolve(protectedState));
    expect(
      (afterProtected.players[id("p0")]!.roleState as { lastProtectedId: UserId | null })
        .lastProtectedId,
    ).toBe(id("p1"));
    // A night where the priest protects nobody clears it to null.
    const idleState = makeState(["priest", "villager", "villager"]);
    const afterIdle = applyTransition(idleState, resolve(idleState));
    expect(
      (afterIdle.players[id("p0")]!.roleState as { lastProtectedId: UserId | null })
        .lastProtectedId,
    ).toBeNull();
  });
});

describe("guardian substitution", () => {
  test("the guardian dies in place of their protegee, with audit cause guardian_substitution, and the protegee survives", () => {
    const state = setRoleState(
      makeState(["guardian", "werewolf", "werewolf", "villager"], {
        p1: action("p3"),
        p2: action("p3"),
      }),
      "p0",
      { protegeeId: id("p3") },
    );
    const transition = resolve(state);
    expect(deadPlayerIds(transition)).toEqual(["p0"]);
    expect(auditDeaths(transition)).toEqual([
      { playerId: id("p0"), cause: "guardian_substitution" },
    ]);
  });

  test("a bonded CURSED protegee attacked by the wolves does not convert — the guardian absorbs it", () => {
    const state = setRoleState(
      makeState(["guardian", "werewolf", "werewolf", "cursed"], {
        p1: action("p3"),
        p2: action("p3"),
      }),
      "p0",
      { protegeeId: id("p3") },
    );
    const transition = resolve(state);
    expect(deadPlayerIds(transition)).toEqual(["p0"]);
    expect(conversions(transition)).toEqual([]);
  });

  test("protegee attacked by BOTH wolves and serial killer: the guardian dies once and the protegee still survives", () => {
    const state = setRoleState(
      makeState(["guardian", "werewolf", "serial_killer", "villager"], {
        p1: action("p3"),
        p2: { "serial_killer.visit": { targetId: id("p3") } },
      }),
      "p0",
      { protegeeId: id("p3") },
    );
    const transition = resolve(state);
    // The guardian dies once for the protegee; the wolf that the visiting
    // serial killer clashed with also dies. The protegee survives.
    expect(deadPlayerIds(transition)).toEqual(["p0", "p1"]);
    expect(deadPlayerIds(transition)).not.toContain("p3");
  });

  test("bonding is offered on night 1 only, and not once already bonded", () => {
    const night1 = makeState(["guardian", "villager", "villager"]);
    const offered = getAvailableActions(night1, id("p0")).find((a) => a.id === "guardian.bond");
    expect(offered?.type).toBe("target");
    const bonded = setRoleState(night1, "p0", { protegeeId: id("p1") });
    expect(
      getAvailableActions(bonded, id("p0")).find((a) => a.id === "guardian.bond"),
    ).toBeUndefined();
    const night2 = { ...night1, day: 2 };
    expect(
      getAvailableActions(night2, id("p0")).find((a) => a.id === "guardian.bond"),
    ).toBeUndefined();
  });

  test("bonding to yourself is INVALID_TARGET", () => {
    const state = makeState(["guardian", "villager", "villager"]);
    const result = validateCommand(
      state,
      id("p0"),
      {
        commandId: "c1",
        phaseId: state.phase!.id,
        type: "night.action.set",
        payload: { action: "guardian.bond", targetId: id("p0") },
      } as never,
      { now: 1 },
    );
    expect(result).toEqual({ code: "INVALID_TARGET" });
  });

  test("a dead guardian protects nobody", () => {
    const state = setRoleState(
      makeState(["guardian", "werewolf", "werewolf", "villager"], {
        p1: action("p3"),
        p2: action("p3"),
      }),
      "p0",
      { protegeeId: id("p3") },
    );
    const dead = {
      ...state,
      players: {
        ...state.players,
        [id("p0")]: { ...state.players[id("p0")]!, status: "dead" as const },
      },
    };
    const transition = resolve(dead);
    expect(deadPlayerIds(transition)).toEqual(["p3"]);
  });

  test("the guardian being separately attacked the same night results in one death", () => {
    // The wolves attack the guardian's own house while the serial killer hits
    // the protegee: the guardian is hit directly AND substitutes, dying once.
    const state = setRoleState(
      makeState(["guardian", "werewolf", "serial_killer", "villager", "villager"], {
        p1: action("p0"),
        p2: { "serial_killer.visit": { targetId: id("p3") } },
      }),
      "p0",
      { protegeeId: id("p3") },
    );
    const transition = resolve(state);
    expect(deadPlayerIds(transition)).toEqual(["p0"]);
    expect(auditDeaths(transition)).toEqual([
      { playerId: id("p0"), cause: "guardian_substitution" },
    ]);
  });
});

describe("priest and guardian together", () => {
  test("priest and guardian covering the same player: the target lives and so does the GUARDIAN", () => {
    const state = setRoleState(
      makeState(["priest", "guardian", "werewolf", "werewolf", "villager"], {
        p0: { "priest.protect": { targetId: id("p4") } },
        p2: action("p4"),
        p3: action("p4"),
      }),
      "p1",
      { protegeeId: id("p4") },
    );
    const transition = resolve(state);
    expect(deadPlayerIds(transition)).toEqual([]);
  });

  test("a guardian's substitution death triggers the lover link if the guardian was a lover", () => {
    const state = setRoleState(
      makeState(["guardian", "werewolf", "werewolf", "villager", "cupid"], {
        p1: action("p3"),
        p2: action("p3"),
      }),
      "p0",
      { protegeeId: id("p3") },
    );
    const linked = {
      ...state,
      players: {
        ...state.players,
        [id("p4")]: { ...state.players[id("p4")]!, roleState: { linked: [id("p0"), id("p3")] } },
      },
    };
    const transition = resolve(linked);
    // The guardian dies by substitution and their lover dies with them.
    expect(deadPlayerIds(transition)).toEqual(["p0", "p3"]);
    expect(auditDeaths(transition)).toContainEqual({
      playerId: id("p0"),
      cause: "guardian_substitution",
    });
    expect(auditDeaths(transition)).toContainEqual({ playerId: id("p3"), cause: "lover_link" });
  });
});

describe("regression: the restructure changes nothing without the new roles", () => {
  test("hunter retaliation still repels a whole attack and still kills an attacker, for both the wolves and the serial killer", () => {
    const wolves = resolve(
      makeState(["werewolf", "werewolf", "hunter", "villager"], {
        p0: action("p2"),
        p1: action("p2"),
      }),
      "seed",
    );
    expect(deadPlayerIds(wolves)).toEqual(["p0"]);
    expect(auditDeaths(wolves)).toEqual([{ playerId: id("p0"), cause: "hunter_retaliation" }]);

    const sk = resolve(
      makeState(["serial_killer", "hunter", "villager"], {
        p0: { "serial_killer.visit": { targetId: id("p1") } },
      }),
      "same",
    );
    expect(deadPlayerIds(sk)).toEqual(["p0"]);
    expect(auditDeaths(sk)).toEqual([{ playerId: id("p0"), cause: "hunter_retaliation" }]);
  });

  test("the serial-killer/wolf clash still resolves as it does today", () => {
    const skWins = resolve(
      makeState(["werewolf", "serial_killer", "villager"], {
        p1: { "serial_killer.visit": { targetId: id("p0") } },
      }),
      "seed",
    );
    expect(deadPlayerIds(skWins)).toEqual(["p0"]);
    expect(auditDeaths(skWins)).toEqual([{ playerId: id("p0"), cause: "serial_killer_attack" }]);

    const wolfWins = resolve(
      makeState(["werewolf", "serial_killer", "villager"], {
        p1: { "serial_killer.visit": { targetId: id("p0") } },
      }),
      "c",
    );
    expect(deadPlayerIds(wolfWins)).toEqual(["p1"]);
    expect(auditDeaths(wolfWins)).toEqual([{ playerId: id("p1"), cause: "wolf_attack" }]);
  });

  test("the Cursed still converts on a clean pack kill", () => {
    const transition = resolve(
      makeState(["werewolf", "werewolf", "cursed"], {
        p0: action("p2"),
        p1: action("p2"),
      }),
    );
    expect(deadPlayerIds(transition)).toEqual([]);
    expect(conversions(transition)).toEqual([{ playerId: "p2", cause: "cursed" }]);
  });

  test("the Alpha still converts at its chance, and the Veteran/Serial Killer/Seer exceptions still hold", () => {
    const converts = resolve(
      makeState(["alpha_wolf", "werewolf", "villager"], {
        p0: action("p2"),
        p1: action("p2"),
      }),
      "seed-8",
    );
    expect(deadPlayerIds(converts)).toEqual([]);
    expect(conversions(converts)).toEqual([{ playerId: "p2", cause: "alpha_wolf" }]);

    for (const role of ["veteran", "serial_killer", "seer"] as const) {
      const transition = resolve(
        makeState(["alpha_wolf", "werewolf", role], {
          p0: action("p2"),
          p1: action("p2"),
        }),
        "seed-8",
      );
      expect(deadPlayerIds(transition)).toEqual(["p2"]);
      expect(conversions(transition)).toEqual([]);
    }
  });

  test("harlot exposure still fires in both its cases", () => {
    // A harlot who visits a wolf's own house while the wolf is home dies.
    const exposure = resolve(
      makeState(["werewolf", "harlot", "villager"], {
        p1: { "harlot.visit": { targetId: id("p0") } },
      }),
    );
    expect(deadPlayerIds(exposure)).toEqual(["p1"]);
    expect(auditDeaths(exposure)).toEqual([{ playerId: id("p1"), cause: "harlot_exposure" }]);

    // A harlot hit while away from home dies from exposure.
    const hitAway = resolve(
      makeState(["werewolf", "harlot", "villager"], {
        p0: action("p2"),
        p1: { "harlot.visit": { targetId: id("p2") } },
      }),
    );
    expect(deadPlayerIds(hitAway)).toEqual(["p1", "p2"]);
    expect(auditDeaths(hitAway)).toContainEqual({
      playerId: id("p1"),
      cause: "harlot_exposure",
    });
  });

  test("DETERMINISM: a fixed seed produces the same night outcome as before this change for a game containing none of the new roles", () => {
    // These exact outcomes are pinned by the pre-existing night.test.ts suite;
    // the restructure must reproduce them bit-for-bit for the same seed.
    const attack = resolve(
      makeState(["werewolf", "werewolf", "villager"], {
        p0: action("p2"),
        p1: action("p2"),
      }),
      "seed",
    );
    expect(deadPlayerIds(attack)).toEqual(["p2"]);
    expect(auditDeaths(attack)).toEqual([{ playerId: id("p2"), cause: "wolf_attack" }]);

    const cursed = resolve(
      makeState(["werewolf", "werewolf", "cursed"], {
        p0: action("p2"),
        p1: action("p2"),
      }),
      "seed",
    );
    expect(deadPlayerIds(cursed)).toEqual([]);
    expect(conversions(cursed)).toEqual([{ playerId: "p2", cause: "cursed" }]);

    const clash = resolve(
      makeState(["werewolf", "serial_killer", "villager"], {
        p1: { "serial_killer.visit": { targetId: id("p0") } },
      }),
      "seed",
    );
    expect(deadPlayerIds(clash)).toEqual(["p0"]);
    expect(auditDeaths(clash)).toEqual([{ playerId: id("p0"), cause: "serial_killer_attack" }]);
  });
});
