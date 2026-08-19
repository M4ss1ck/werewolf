import { describe, expect, test } from "bun:test";
import type { PlayerState } from "../state.ts";
import { getPerceivedRole } from "./perceived.ts";

const id = (value: string) => value as PlayerState["id"];

function player(role: PlayerState["role"], roleState: unknown): PlayerState {
  return {
    id: id("p0"),
    status: "alive",
    originalRole: role,
    role,
    faction: "village",
    roleState,
    phaseState: { phaseId: 1 as never },
  };
}

describe("getPerceivedRole", () => {
  test("a non-drunk player's perceived role equals their real role", () => {
    expect(getPerceivedRole(player("seer", {}))).toBe("seer");
    expect(getPerceivedRole(player("villager", {}))).toBe("villager");
    expect(getPerceivedRole(player("werewolf", {}))).toBe("werewolf");
  });

  test("a drunk's perceived role is their perceivedRole", () => {
    expect(getPerceivedRole(player("drunk", { perceivedRole: "seer" }))).toBe("seer");
  });

  test("a drunk with a malformed or null roleState falls back to drunk rather than throwing", () => {
    expect(getPerceivedRole(player("drunk", { perceivedRole: null }))).toBe("drunk");
    expect(getPerceivedRole(player("drunk", {}))).toBe("drunk");
    expect(getPerceivedRole(player("drunk", null))).toBe("drunk");
    expect(getPerceivedRole(player("drunk", { perceivedRole: 42 }))).toBe("drunk");
    expect(getPerceivedRole(player("drunk", { perceivedRole: undefined }))).toBe("drunk");
  });
});
