import { describe, expect, test } from "bun:test";
import { ROLE_IDS, WOLF_ROLE_IDS } from "@werewolf/protocol";
import { CULT_CHAT_ROLES, isPackMember, roleRegistry, WOLF_CHAT_ROLES } from "./registry.ts";

describe("WOLF_ROLE_IDS and the role registry agree", () => {
  test("every id in WOLF_ROLE_IDS has startingFaction wolves, and no other role does", () => {
    for (const role of ROLE_IDS) {
      const isWolf = (WOLF_ROLE_IDS as readonly string[]).includes(role);
      expect(roleRegistry[role].startingFaction === "wolves", role).toBe(isWolf);
    }
  });
});

test("wolf chat is the pack, not the wolf faction", () => {
  expect([...WOLF_CHAT_ROLES].sort()).toEqual(["alpha_wolf", "cub", "werewolf"]);
  // The sorcerer is wolf-faction and gets neither the channel nor the ballot.
  expect(WOLF_CHAT_ROLES.has("sorcerer")).toBe(false);
  expect(isPackMember({ role: "sorcerer" })).toBe(false);
  expect(roleRegistry.sorcerer.startingFaction).toBe("wolves");
});

test("cult chat is the leader and its converts", () => {
  expect([...CULT_CHAT_ROLES].sort()).toEqual(["cult_leader", "cultist"]);
});
