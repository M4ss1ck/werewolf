import { describe, expect, test, vi } from "vitest";

import { currentRoute, navigate } from "./routes.tsx";

describe("currentRoute", () => {
  test.each([
    ["/", { type: "games" }],
    ["/games", { type: "games" }],
    ["/create", { type: "create" }],
    ["/profile", { type: "profile" }],
    ["/games/game-1", { type: "game", id: "game-1" }],
    ["/games/game-1/replay", { type: "replay", id: "game-1" }],
  ] as const)("maps %s", (path, expected) => {
    expect(currentRoute(path)).toEqual(expected);
  });

  test("unknown paths fall back to the games route", () => {
    expect(currentRoute("/nowhere")).toEqual({ type: "games" });
    expect(currentRoute("/games")).toEqual({ type: "games" });
  });
});

describe("navigate", () => {
  test("pushes the path and fires popstate so listeners re-resolve the route", () => {
    const listener = vi.fn();
    window.addEventListener("popstate", listener);

    navigate("/create");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(currentRoute()).toEqual({ type: "create" });

    window.removeEventListener("popstate", listener);
  });
});
