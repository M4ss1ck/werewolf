import { describe, expect, test } from "bun:test";
import { ACTION_IDS } from "@werewolf/protocol";
import { getActionSpec } from "./action-spec.ts";
import { roleRegistry } from "./registry.ts";

describe("action specs", () => {
  test("every ActionId is declared by exactly one role", () => {
    for (const id of ACTION_IDS) {
      const owners = Object.values(roleRegistry).filter((role) =>
        role.actions?.some((action) => action.id === id),
      );
      expect(owners).toHaveLength(1);
    }
  });

  test("no role declares an action outside the ActionId vocabulary", () => {
    for (const role of Object.values(roleRegistry)) {
      for (const action of role.actions ?? []) {
        expect(ACTION_IDS).toContain(action.id);
      }
    }
  });

  test("getActionSpec finds every declared action", () => {
    for (const id of ACTION_IDS) {
      expect(getActionSpec(id)?.id).toBe(id);
    }
  });

  test("only the actions that travel are marked as travelling", () => {
    const travelling = ACTION_IDS.filter((id) => getActionSpec(id)?.travelsToTarget === true);
    expect([...travelling].sort()).toEqual([
      "cult.convert",
      "detective.investigate",
      "harlot.visit",
      "lone_wolf.search",
      "serial_killer.visit",
    ]);
  });

  test("only priest and cupid may target themselves", () => {
    const selfTargetable = ACTION_IDS.filter((id) => {
      const target = getActionSpec(id)?.target;
      return target != null && target.pool === "all" && target.excludeSelf === false;
    });
    expect([...selfTargetable].sort()).toEqual(["cupid.link", "priest.protect"]);
  });
});
