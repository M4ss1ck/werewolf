import { describe, expect, test } from "bun:test";
import type { RoleId } from "@werewolf/protocol";
import {
  composeBalancedGame,
  getStartingWolfCount,
  minimumVanillaVillagers,
  WOLF_REPLACING_ROLES,
  wolfCountForComposition,
} from "../index.ts";

const playerCounts = Array.from({ length: 20 }, (_, index) => index + 5);
const seeds = Array.from({ length: 40 }, (_, index) => `seed-${index}`);

/** First composition for `playerCount` that contains `role` (and none of
 * `exclude`), so a test can pin behaviour on a composition that actually has
 * the role it is about. */
function findCompositionWith(
  playerCount: number,
  role: RoleId,
  exclude: readonly RoleId[] = [],
): RoleId[] {
  for (let seed = 0; seed < 2000; seed += 1) {
    const roles = composeBalancedGame({ playerCount, seed: `find-${seed}` });
    if (roles.includes(role) && !exclude.some((excluded) => roles.includes(excluded))) return roles;
  }
  throw new Error(`no composition with ${role} for ${playerCount} players`);
}

describe("balance-v1 role composer", () => {
  test.each(playerCounts)("creates a valid composition for %i players", (playerCount) => {
    for (const seed of seeds) {
      const roles = composeBalancedGame({ playerCount, seed, balanceVersion: 1 });
      expect(roles).toHaveLength(playerCount);
      const expectedWolves =
        playerCount === 5 && roles.includes("serial_killer")
          ? 0
          : Math.max(
              0,
              getStartingWolfCount(playerCount) -
                WOLF_REPLACING_ROLES.filter((role) => roles.includes(role)).length,
            );
      expect(roles.filter((role) => role === "werewolf")).toHaveLength(expectedWolves);
      expect([0, 2].includes(roles.filter((role) => role === "mason").length)).toBe(true);
      expect(roles.filter((role) => role === "villager").length).toBeGreaterThanOrEqual(
        minimumVanillaVillagers(playerCount),
      );
      for (const role of [
        "seer",
        "harlot",
        "princess",
        "hunter",
        "cursed",
        "veteran",
        "serial_killer",
        "drunk",
      ] as const) {
        expect(roles.filter((candidate) => candidate === role).length).toBeLessThanOrEqual(1);
      }
      if (playerCount < 7) expect(roles).not.toContain("hunter");
      if (playerCount < 7) expect(roles).not.toContain("drunk");
      if (playerCount < 8) expect(roles).not.toContain("mason");
      if (playerCount === 5 || playerCount === 7) expect(roles).not.toContain("cursed");
      if (playerCount === 5 || playerCount === 6) {
        expect(roles.includes("seer") && roles.includes("princess")).toBe(false);
      }
    }
  });

  test("a 5-player composition containing serial_killer has no werewolves", () => {
    const roles = findCompositionWith(5, "serial_killer");
    expect(roles.filter((role) => role === "werewolf")).toHaveLength(0);
  });

  test("a 5-player composition without serial_killer keeps exactly one werewolf", () => {
    for (let seed = 0; seed < 2000; seed += 1) {
      const roles = composeBalancedGame({ playerCount: 5, seed: `find-${seed}` });
      if (roles.includes("serial_killer")) continue;
      expect(roles.filter((role) => role === "werewolf")).toHaveLength(1);
      return;
    }
    throw new Error("no 5-player composition without serial_killer");
  });

  test("a 6+ player composition containing serial_killer keeps the normal wolf count", () => {
    for (const playerCount of [6, 7, 8, 10, 14, 20]) {
      const roles = findCompositionWith(playerCount, "serial_killer", ["alpha_wolf", "cub"]);
      expect(roles.filter((role) => role === "werewolf")).toHaveLength(
        getStartingWolfCount(playerCount),
      );
    }
  });

  test("veteran never changes the wolf count at any player count", () => {
    for (const playerCount of [5, 6, 7, 8, 10, 14, 20]) {
      const roles = findCompositionWith(playerCount, "veteran", [
        "serial_killer",
        "alpha_wolf",
        "cub",
      ]);
      expect(roles.filter((role) => role === "werewolf")).toHaveLength(
        getStartingWolfCount(playerCount),
      );
    }
  });

  test("a 10-player composition containing alpha_wolf has one fewer plain werewolf", () => {
    const roles = findCompositionWith(10, "alpha_wolf", ["cub"]);
    expect(roles.filter((role) => role === "werewolf")).toHaveLength(getStartingWolfCount(10) - 1);
  });

  test("a composition containing cub has one fewer plain werewolf", () => {
    const roles = findCompositionWith(10, "cub", ["alpha_wolf"]);
    expect(roles.filter((role) => role === "werewolf")).toHaveLength(getStartingWolfCount(10) - 1);
  });

  test("a composition containing both alpha_wolf and cub has two fewer plain werewolves", () => {
    for (let seed = 0; seed < 2000; seed += 1) {
      const roles = composeBalancedGame({ playerCount: 10, seed: `find-${seed}` });
      if (roles.includes("alpha_wolf") && roles.includes("cub")) {
        expect(roles.filter((role) => role === "werewolf")).toHaveLength(
          getStartingWolfCount(10) - 2,
        );
        return;
      }
    }
    throw new Error("no 10-player composition with both alpha_wolf and cub");
  });

  test("wolfCountForComposition never returns a negative count", () => {
    expect(wolfCountForComposition(5, ["alpha_wolf", "cub"])).toBe(0);
    expect(wolfCountForComposition(7, ["alpha_wolf", "cub"])).toBe(0);
  });

  test("never two cubs in a composition", () => {
    for (const playerCount of [7, 8, 10, 14, 20]) {
      for (let seed = 0; seed < 2000; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `find-${seed}` });
        expect(roles.filter((role) => role === "cub").length).toBeLessThanOrEqual(1);
      }
    }
    // The candidate pool grows with every special role, and these loops sample
    // 10 000 compositions; 30s is no longer a safe budget.
  }, 60000);

  test("cub never appears below 7 players", () => {
    for (const playerCount of [5, 6]) {
      for (let seed = 0; seed < 2000; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `find-${seed}` });
        expect(roles).not.toContain("cub");
      }
    }
  });

  test("alpha_wolf never appears in a 9-player composition", () => {
    for (let seed = 0; seed < 2000; seed += 1) {
      const roles = composeBalancedGame({ playerCount: 9, seed: `find-${seed}` });
      expect(roles).not.toContain("alpha_wolf");
    }
  });

  test("never two alpha wolves in a composition", () => {
    for (const playerCount of [10, 14, 20]) {
      for (let seed = 0; seed < 2000; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `find-${seed}` });
        expect(roles.filter((role) => role === "alpha_wolf").length).toBeLessThanOrEqual(1);
      }
    }
  }, 30000);

  test("never two drunks in a composition", () => {
    for (const playerCount of [7, 8, 10, 14, 20]) {
      for (let seed = 0; seed < 2000; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `find-${seed}` });
        expect(roles.filter((role) => role === "drunk").length).toBeLessThanOrEqual(1);
      }
    }
    // The candidate pool grows with every special role, and these loops sample
    // 10 000 compositions; 30s is no longer a safe budget.
  }, 60000);

  test("drunk never appears below 7 players", () => {
    for (const playerCount of [5, 6]) {
      for (let seed = 0; seed < 2000; seed += 1) {
        const roles = composeBalancedGame({ playerCount, seed: `find-${seed}` });
        expect(roles).not.toContain("drunk");
      }
    }
  });

  test("is deterministic for the same seed and version", () => {
    for (const playerCount of playerCounts) {
      const first = composeBalancedGame({ playerCount, seed: "same", balanceVersion: 1 });
      const second = composeBalancedGame({ playerCount, seed: "same", balanceVersion: 1 });
      expect(second).toEqual(first);
    }
  });

  test("produces diverse compositions across seeds", () => {
    for (const playerCount of [5, 6, 8, 10, 14, 20, 24]) {
      const compositions = new Set(
        Array.from({ length: 100 }, (_, seed) =>
          composeBalancedGame({ playerCount, seed }).join(","),
        ),
      );
      expect(compositions.size).toBeGreaterThan(1);
    }
  });

  test("rejects fewer than five players", () => {
    expect(() => composeBalancedGame({ playerCount: 4, seed: "seed" })).toThrow();
    expect(() => getStartingWolfCount(4)).toThrow("Minimum 5 players");
  });
});
