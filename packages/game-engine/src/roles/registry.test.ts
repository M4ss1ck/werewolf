import { describe, expect, test } from "bun:test";
import { ROLE_IDS, WOLF_ROLE_IDS } from "@werewolf/protocol";
import { roleRegistry } from "./registry.ts";

describe("WOLF_ROLE_IDS and the role registry agree", () => {
  test("every id in WOLF_ROLE_IDS has startingFaction wolves, and no other role does", () => {
    for (const role of ROLE_IDS) {
      const isWolf = (WOLF_ROLE_IDS as readonly string[]).includes(role);
      expect(roleRegistry[role].startingFaction === "wolves", role).toBe(isWolf);
    }
  });
});
