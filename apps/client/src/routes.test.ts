import { describe, expect, test, vi } from "vitest";

import { currentRoute, navigate, replace, sameRoute } from "./routes.tsx";

describe("currentRoute", () => {
  test.each([
    ["/", { type: "games" }],
    ["/games", { type: "games" }],
    ["/create", { type: "create" }],
    ["/profile", { type: "profile" }],
    ["/games/game-1", { type: "game", id: "game-1" }],
    ["/games/game-1/replay", { type: "replay", id: "game-1" }],
    [
      "/games/game-1/entry",
      { type: "entry", reference: { kind: "public-game", gameId: "game-1" } },
    ],
    [
      "/join?code=k7m3-p9t2-wq",
      {
        type: "entry",
        reference: { kind: "invitation", code: "K7M3P9T2WQ" },
        rawCode: "k7m3-p9t2-wq",
      },
    ],
  ] as const)("maps %s", (path, expected) => {
    expect(currentRoute(path)).toEqual(expected);
  });

  test("unknown paths fall back to the games route", () => {
    expect(currentRoute("/nowhere")).toEqual({ type: "games" });
    expect(currentRoute("/games")).toEqual({ type: "games" });
  });

  test("keeps an invalid invitation code available for the preview error", () => {
    expect(currentRoute("/join?code=not-a-code")).toEqual({
      type: "entry",
      reference: { kind: "invitation", code: "not-a-code" },
      rawCode: "not-a-code",
    });
  });
});

test("sameRoute notices invitation query changes", () => {
  expect(
    sameRoute(currentRoute("/join?code=K7M3P9T2WQ"), currentRoute("/join?code=K7M3P9T2WR")),
  ).toBe(false);
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

test("replace removes an entry query without adding browser history", () => {
  const pushState = vi.spyOn(window.history, "pushState");
  const replaceState = vi.spyOn(window.history, "replaceState");

  replace("/games/game-1");

  expect(replaceState).toHaveBeenCalledWith({}, "", "/games/game-1");
  expect(pushState).not.toHaveBeenCalled();
  pushState.mockRestore();
  replaceState.mockRestore();
});
