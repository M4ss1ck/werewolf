import { describe, expect, test } from "bun:test";
import {
  composeBalancedGame,
  getStartingWolfCount,
  minimumVanillaVillagers,
} from "../index.ts";

const playerCounts = Array.from({ length: 20 }, (_, index) => index + 5);
const seeds = Array.from({ length: 40 }, (_, index) => `seed-${index}`);

describe("balance-v1 role composer", () => {
  test.each(playerCounts)("creates a valid composition for %i players", (playerCount) => {
    for (const seed of seeds) {
      const roles = composeBalancedGame({ playerCount, seed, balanceVersion: 1 });
      expect(roles).toHaveLength(playerCount);
      expect(roles.filter((role) => role === "werewolf")).toHaveLength(getStartingWolfCount(playerCount));
      expect([0, 2].includes(roles.filter((role) => role === "mason").length)).toBe(true);
      expect(roles.filter((role) => role === "villager").length).toBeGreaterThanOrEqual(
        minimumVanillaVillagers(playerCount),
      );
      for (const role of ["seer", "harlot", "princess", "hunter", "cursed"] as const) {
        expect(roles.filter((candidate) => candidate === role).length).toBeLessThanOrEqual(1);
      }
      if (playerCount < 7) expect(roles).not.toContain("hunter");
      if (playerCount < 8) expect(roles).not.toContain("mason");
      if (playerCount === 5 || playerCount === 7) expect(roles).not.toContain("cursed");
      if (playerCount === 5 || playerCount === 6) {
        expect(roles.includes("seer") && roles.includes("princess")).toBe(false);
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
