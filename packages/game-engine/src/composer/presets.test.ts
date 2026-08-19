import { describe, expect, test } from "bun:test";
import type { PresetId, RoleId } from "@werewolf/protocol";
import {
  availableSpecialRoles,
  composeBalancedGame,
  isValidComposition,
  presets,
  roleAvailabilityMinimums,
} from "../index.ts";

/** Roles added by the roster expansion; a classic composition must never
 * contain any of them. */
const EXPANSION_ROLES: readonly RoleId[] = [
  "drunk",
  "mayor",
  "guardian",
  "priest",
  "detective",
  "cupid",
  "cub",
  "sorcerer",
  "cult_leader",
  "cultist",
  "lone_wolf",
];

const PRESET_IDS: readonly PresetId[] = ["classic", "chaos", "cult"];

describe("composition presets", () => {
  test("every role named in every preset is in availableSpecialRoles", () => {
    for (const preset of Object.values(presets)) {
      for (const role of [...preset.specialRoles, ...preset.guaranteed]) {
        expect(availableSpecialRoles).toContain(role);
      }
    }
  });

  test("the default preset is classic", () => {
    for (const playerCount of [5, 6, 8, 10, 14, 20]) {
      for (let seed = 0; seed < 20; seed += 1) {
        const implicit = composeBalancedGame({ playerCount, seed: `seed-${seed}` });
        const explicit = composeBalancedGame({
          playerCount,
          seed: `seed-${seed}`,
          preset: "classic",
        });
        expect(explicit).toEqual(implicit);
      }
    }
  });

  test("a classic composition never contains a roster-expansion role", () => {
    for (const playerCount of [5, 6, 8, 10, 14, 20]) {
      for (let seed = 0; seed < 100; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `seed-${seed}`, preset: "classic" });
        for (const role of EXPANSION_ROLES) {
          expect(roles).not.toContain(role);
        }
      }
    }
  });

  test("a cult composition always contains cult_leader", () => {
    for (const playerCount of [9, 10, 12, 14, 20]) {
      for (let seed = 0; seed < 100; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `seed-${seed}`, preset: "cult" });
        expect(roles).toContain("cult_leader");
      }
    }
  });

  test("a chaos composition may contain expansion roles", () => {
    for (const playerCount of [9, 10, 14, 20]) {
      let found = false;
      for (let seed = 0; seed < 2000; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `seed-${seed}`, preset: "chaos" });
        if (EXPANSION_ROLES.some((role) => roles.includes(role))) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
  });

  test("every role with an availability minimum is in availableSpecialRoles", () => {
    // A role can only be dealt if it is in the pool. Declaring a minimum player
    // count for a role the composer never draws is a role nobody can play.
    for (const role of Object.keys(roleAvailabilityMinimums) as RoleId[]) {
      expect(availableSpecialRoles).toContain(role);
    }
  });

  test("a chaos composition may contain lone_wolf", () => {
    let found = false;
    for (let seed = 0; seed < 2000; seed += 1) {
      const roles = composeBalancedGame({ playerCount: 14, seed: `seed-${seed}`, preset: "chaos" });
      if (roles.includes("lone_wolf")) {
        // The Lone Wolf is a dead seat without an Alpha to hunt.
        expect(roles).toContain("alpha_wolf");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("cultist is never dealt by any preset", () => {
    for (const preset of PRESET_IDS) {
      // The cult preset needs at least 9 players (cult_leader's minimum).
      const counts = preset === "cult" ? [9, 10, 14, 20] : [5, 6, 8, 9, 10, 14, 20];
      for (const playerCount of counts) {
        for (let seed = 0; seed < 50; seed += 1) {
          const roles = composeBalancedGame({ playerCount, seed: `seed-${seed}`, preset });
          expect(roles).not.toContain("cultist");
        }
      }
    }
  });

  test("every preset produces a valid composition across player counts", () => {
    for (const preset of PRESET_IDS) {
      const counts =
        preset === "cult" ? [9, 10, 12, 14, 20, 24] : [5, 6, 7, 8, 9, 10, 12, 14, 20, 24];
      for (const playerCount of counts) {
        for (let seed = 0; seed < 30; seed += 1) {
          const roles = composeBalancedGame({ playerCount, seed: `seed-${seed}`, preset });
          expect(isValidComposition(roles, playerCount)).toBe(true);
        }
      }
    }
  });

  test("the cult preset below its minimum player count throws", () => {
    for (const playerCount of [5, 6, 7, 8]) {
      expect(() => composeBalancedGame({ playerCount, seed: "seed", preset: "cult" })).toThrow(
        "No valid balanced composition",
      );
    }
  });

  test("same seed and preset give the same composition every time", () => {
    for (const preset of PRESET_IDS) {
      // The cult preset needs at least 9 players (cult_leader's minimum).
      const counts = preset === "cult" ? [9, 14, 20] : [5, 9, 14, 20];
      for (const playerCount of counts) {
        const first = composeBalancedGame({ playerCount, seed: "same", preset });
        const second = composeBalancedGame({ playerCount, seed: "same", preset });
        expect(second).toEqual(first);
      }
    }
  });
});
