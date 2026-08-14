import { describe, expect, test } from "bun:test";
import { SeededRng } from "./rng.ts";

describe("SeededRng", () => {
  test("repeats the same sequence for the same seed and scope", () => {
    const first = new SeededRng("seed").derive("composition");
    const second = new SeededRng("seed").derive("composition");
    expect([first.float(), first.int(100), first.float()]).toEqual([
      second.float(),
      second.int(100),
      second.float(),
    ]);
  });

  test("derived streams do not share state", () => {
    const root = new SeededRng("seed");
    const composition = root.derive("composition");
    root.float();
    const assignment = root.derive("assignment");
    const expected = new SeededRng("seed").derive("assignment");
    composition.float();
    composition.float();
    expect(assignment.float()).toBe(expected.float());
  });

  test("selects weighted values", () => {
    const value = new SeededRng("seed").weightedPick([{ value: "only", weight: 1 }]);
    expect(value).toBe("only");
  });
});
