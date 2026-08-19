import { describe, expect, test } from "bun:test";
import { DayActionSetPayloadSchema, NightActionSetPayloadSchema } from "./commands.ts";
import { ACTION_IDS } from "./enums.ts";

/** Every ActionId must be submittable. An action id that exists in the engine
 * but not in a wire payload schema is a role nobody can actually play: the
 * engine offers it and validates it, and the HTTP boundary rejects it. That is
 * exactly what happened to the serial killer, silently, for as long as the role
 * existed. */
function acceptedActions(schema: { options: readonly unknown[] }): Set<string> {
  const accepted = new Set<string>();
  for (const option of schema.options) {
    const shape = (option as { shape: { action: { value: string } } }).shape;
    accepted.add(shape.action.value);
  }
  return accepted;
}

describe("night and day action payload schemas", () => {
  test("every ActionId is accepted by exactly one of the two payload schemas", () => {
    const night = acceptedActions(NightActionSetPayloadSchema as never);
    const day = acceptedActions(DayActionSetPayloadSchema as never);
    for (const action of ACTION_IDS) {
      const inNight = night.has(action);
      const inDay = day.has(action);
      expect(
        inNight || inDay,
        `${action} is in ACTION_IDS but no wire payload schema accepts it, so it can never be submitted`,
      ).toBe(true);
      expect(inNight && inDay, `${action} is accepted by both schemas`).toBe(false);
    }
  });

  test("neither schema accepts an action that is not an ActionId", () => {
    const known = new Set<string>(ACTION_IDS);
    for (const action of [
      ...acceptedActions(NightActionSetPayloadSchema as never),
      ...acceptedActions(DayActionSetPayloadSchema as never),
    ])
      expect(known.has(action), `${action} is accepted on the wire but is not an ActionId`).toBe(
        true,
      );
  });
});
