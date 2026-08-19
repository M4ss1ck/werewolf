import { describe, expect, test } from "bun:test";
import { ROLE_IDS } from "@werewolf/protocol";
import {
  availableSpecialRoles,
  DRUNK_FAKE_ROLES,
  getComposition,
  maximumCopies,
  NEVER_DEALT,
  requiredCombinations,
  roleAvailabilityMinimums,
  WOLF_REPLACING_ROLES,
} from "./composition.ts";

describe("role composition metadata", () => {
  // The check that would have caught the Lone Wolf. Every role is either
  // dealt by the composer or explicitly declared undealt; there is no
  // third state in which a role silently exists but is unreachable.
  test("every role is either dealt or explicitly never dealt", () => {
    for (const role of ROLE_IDS) {
      const declared = getComposition(role) !== undefined;
      expect(declared || NEVER_DEALT.has(role)).toBe(true);
      expect(declared && NEVER_DEALT.has(role)).toBe(false);
    }
  });

  test("availableSpecialRoles is exactly the roles with composition", () => {
    const expected = ROLE_IDS.filter((role) => getComposition(role) !== undefined);
    expect([...availableSpecialRoles].sort()).toEqual([...expected].sort());
  });

  test("a required prerequisite is itself dealt", () => {
    for (const [role, prerequisite] of requiredCombinations) {
      expect(getComposition(prerequisite)).toBeDefined();
      expect(availableSpecialRoles).toContain(role);
    }
  });

  test("the derived rosters match the values the composer used before", () => {
    expect(roleAvailabilityMinimums).toEqual({
      cursed: 6,
      hunter: 7,
      drunk: 7,
      mason: 8,
      alpha_wolf: 10,
      mayor: 8,
      cupid: 8,
      priest: 7,
      guardian: 7,
      cub: 7,
      sorcerer: 8,
      detective: 7,
      cult_leader: 9,
      lone_wolf: 10,
    });
    expect([...WOLF_REPLACING_ROLES].sort()).toEqual(["alpha_wolf", "cub"]);
    expect(requiredCombinations).toEqual([["lone_wolf", "alpha_wolf"]]);
    expect([...DRUNK_FAKE_ROLES].sort()).toEqual([
      "cupid",
      "detective",
      "guardian",
      "priest",
      "seer",
    ]);
  });

  test("mason is the only role dealt in pairs", () => {
    for (const role of ROLE_IDS) {
      expect(maximumCopies(role)).toBe(role === "mason" ? 2 : 1);
    }
  });

  test("NEVER_DEALT holds only fill and conversion roles", () => {
    expect([...NEVER_DEALT].sort()).toEqual(["cultist", "villager", "werewolf"]);
  });
});
