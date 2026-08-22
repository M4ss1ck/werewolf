import { describe, expect, test } from "vitest";

import {
  allocateIdentityMarks,
  fnv1a32,
  IDENTITY_PALETTE,
  IdentitySigil,
  identityChordPoints,
} from "./identity.tsx";

describe("chat identity marks", () => {
  function channel(hex: string): [number, number, number] {
    return [0, 2, 4].map(
      (offset) => Number.parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255,
    ) as [number, number, number];
  }

  function relativeLuminance(hex: string): number {
    return channel(hex)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  }

  function contrast(first: string, second: string): number {
    const sorted = [relativeLuminance(first), relativeLuminance(second)].sort(
      (left, right) => right - left,
    );
    const lighter = sorted[0]!;
    const darker = sorted[1]!;
    return (lighter + 0.05) / (darker + 0.05);
  }

  function oklab(hex: string): [number, number, number] {
    const [red, green, blue] = channel(hex).map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    ) as [number, number, number];
    const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
    const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
    const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
    const cubeRoot = (value: number) => Math.cbrt(value);
    const [lRoot, mRoot, sRoot] = [l, m, s].map(cubeRoot) as [number, number, number];
    return [
      0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
      1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
      0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
    ];
  }

  function oklabDistance(first: string, second: string): number {
    return Math.hypot(...oklab(first).map((value, index) => value - oklab(second)[index]!));
  }

  test("uses published FNV-1a UTF-8 fixtures", () => {
    expect(fnv1a32("abc")).toBe(0x1a47e90b);
    expect(fnv1a32("雪")).toBe(0x5050dfe5);
    expect(fnv1a32("display-name")).not.toBe(fnv1a32("different-name"));
  });

  test("allocates same-name cohorts independently of input order", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      userId: `u${index}`,
      displayName: index % 2 === 0 ? "Álex" : "Alex",
    }));
    const forward = allocateIdentityMarks(rows);
    const reverse = allocateIdentityMarks([...rows].reverse());
    expect([...forward.entries()]).toEqual([...reverse.entries()]);
    expect(new Set([...forward.values()].map((mark) => mark.color)).size).toBe(8);
    expect(new Set([...forward.values()].map((mark) => mark.variant)).size).toBe(8);
    const ninth = allocateIdentityMarks([...rows, { userId: "u8", displayName: "Alex" }]).get("u8");
    expect(ninth?.accessibleLabel).toContain("u8");
    expect(ninth?.accessibleLabel).toBe("Alex, user u8");
    expect(ninth?.accessibleLabel).not.toContain("user 8");
    const fullId = "4f37c7b2-6b0f-4d77-a10c-64fb91f7cc80";
    const duplicateLabel = allocateIdentityMarks([
      { userId: fullId, displayName: "Alex" },
      { userId: "another-full-id", displayName: "Alex" },
    ]).get(fullId)?.accessibleLabel;
    expect(duplicateLabel).toBe(`Alex, user ${fullId}`);
    expect(duplicateLabel).not.toBe(`Alex, user ${fullId.slice(-4)}`);
    const stable = allocateIdentityMarks([{ userId: "u0", displayName: "Alex" }]).get("u0")!;
    expect([stable.baseSlot, stable.baseVariant]).toEqual([
      forward.get("u0")?.baseSlot,
      forward.get("u0")?.baseVariant,
    ]);
    expect(
      allocateIdentityMarks([...rows, { userId: "u8", displayName: "Alex" }]).get("u8"),
    ).toEqual(ninth);
  });

  test("keeps collision variants distinct when base colors collide", () => {
    const first = "collision-0";
    const firstSlot = fnv1a32(first) % IDENTITY_PALETTE.length;
    let second = "";
    for (let index = 1; index < 1_000; index += 1) {
      const candidate = `collision-${index}`;
      if (fnv1a32(candidate) % IDENTITY_PALETTE.length === firstSlot) {
        second = candidate;
        break;
      }
    }
    expect(second).not.toBe("");
    const marks = allocateIdentityMarks([
      { userId: first, displayName: "Same" },
      { userId: second, displayName: "Same" },
    ]);
    const firstMark = marks.get(first)!;
    const secondMark = marks.get(second)!;
    expect(firstMark.baseSlot).toBe(secondMark.baseSlot);
    expect(firstMark.variant).not.toBe(secondMark.variant);
    expect(`${firstMark.slot}:${firstMark.variant}`).not.toBe(
      `${secondMark.slot}:${secondMark.variant}`,
    );
  });

  test("terminates deterministically beyond the 56 variant slots", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      userId: `same-name-${index}`,
      displayName: "Same Name",
    }));
    const first = allocateIdentityMarks(rows);
    const second = allocateIdentityMarks([...rows].reverse());
    expect(first.size).toBe(60);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(new Set([...first.values()].slice(0, 8).map((mark) => mark.color)).size).toBe(8);
    expect(new Set([...first.values()].slice(0, 8).map((mark) => mark.variant)).size).toBe(8);
  });

  test("meets contrast and pairwise OKLab separation for the fixed palette", () => {
    const backgrounds = ["#0b1211", "#131e1b", "#182421", "#2c3a35"];
    for (const color of IDENTITY_PALETTE) {
      for (const background of backgrounds)
        expect(contrast(color, background)).toBeGreaterThanOrEqual(5.1);
    }
    for (let index = 0; index < IDENTITY_PALETTE.length; index += 1) {
      for (let next = index + 1; next < IDENTITY_PALETTE.length; next += 1) {
        expect(
          oklabDistance(IDENTITY_PALETTE[index]!, IDENTITY_PALETTE[next]!),
        ).toBeGreaterThanOrEqual(0.09);
      }
    }
  });

  test("keeps the fixed palette and renders a decorative deterministic sigil", () => {
    expect(IDENTITY_PALETTE).toEqual([
      "#FF8C84",
      "#F6B44C",
      "#D9D64C",
      "#76D06B",
      "#4FC7B5",
      "#5AB2F2",
      "#B3A9FF",
      "#EF8DD4",
    ]);
    const mark = allocateIdentityMarks([{ userId: "full-user-id", displayName: "Alex" }]).get(
      "full-user-id",
    )!;
    const element = IdentitySigil({ mark });
    expect(element.props["aria-hidden"]).toBe(true);
    expect(element.props.children).toHaveLength(5);
    expect(element.props.children[1].props.d).toBe("M14.5 6a6 6 0 1 0 3.5 10.8A7 7 0 0 1 14.5 6Z");
    const withAdjacentLabel = IdentitySigil({ mark, label: mark.accessibleLabel });
    const labelledSvg = withAdjacentLabel.props.children[0];
    expect(labelledSvg.props["aria-hidden"]).toBe(true);
    expect(labelledSvg.props.role).toBeUndefined();
    expect(labelledSvg.props["aria-label"]).toBeUndefined();
    expect(withAdjacentLabel.props.children[1].props.children).toBe(mark.accessibleLabel);
  });

  test("uses deterministic clockwise radius-five chord points for every variant", () => {
    expect(identityChordPoints(0)).toEqual({
      start: { x: 12, y: 7 },
      end: { x: 15.54, y: 8.46 },
    });
    expect(identityChordPoints(8)).toEqual({
      start: { x: 12, y: 7 },
      end: { x: 17, y: 12 },
    });
    for (let variant = 0; variant < 56; variant += 1) {
      const points = identityChordPoints(variant);
      expect(identityChordPoints(variant)).toEqual(points);
      for (const point of [points.start, points.end]) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(Math.hypot(point.x - 12, point.y - 12)).toBeCloseTo(5, 1);
      }
    }
  });
});
