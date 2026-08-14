import { expect, test } from "bun:test";

import { BALANCE_VERSION, MIN_PLAYERS } from "./index.ts";

test("a game needs at least five active players", () => {
  expect(MIN_PLAYERS).toBe(5);
});

test("games start on balance version 1", () => {
  expect(BALANCE_VERSION).toBe(1);
});
