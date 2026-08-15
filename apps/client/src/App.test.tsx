import { fireEvent, render, screen } from "@testing-library/react";
import type { EventId, GameId, UserId, ViewerGameSnapshot } from "@werewolf/protocol";
import { afterEach, expect, test, vi } from "vitest";

import { App } from "./App.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

test("renders the sign-in screen when signed out", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Werewolf" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Sign in/ })).toBeInTheDocument();
});

test("renders the cancelled screen for a cancelled game", async () => {
  window.history.replaceState({}, "", "/games/g1");
  const snapshot: ViewerGameSnapshot = {
    game: {
      id: "g1" as GameId,
      name: "Game One",
      ownerUserId: "owner" as UserId,
      status: "cancelled",
      day: 1,
      phase: null,
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 120, voting: 60, night: 60 },
      },
    },
    players: [{ userId: "wren" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "wren" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) =>
      Promise.resolve(
        new Response(
          String(input) === "/api/auth/get-session"
            ? JSON.stringify({ user: { id: "me", username: "wren" } })
            : JSON.stringify(snapshot),
          { status: 200 },
        ),
      ),
    ),
  );
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Game cancelled" })).toBeInTheDocument();
  // The blank-page regression: a cancelled game must never reach the in-game
  // tab bar (PhaseHeader renders nothing without a phase, VillageTab keeps
  // only alive/dead players, so the whole screen rendered empty).
  expect(screen.queryByRole("button", { name: "Village" })).not.toBeInTheDocument();
});

test("a game route offers a way back to the games list", async () => {
  window.history.replaceState({}, "", "/games/g1");
  const snapshot: ViewerGameSnapshot = {
    game: {
      id: "g1" as GameId,
      name: "Game One",
      ownerUserId: "owner" as UserId,
      status: "lobby",
      day: 1,
      phase: null,
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 120, voting: 60, night: 60 },
      },
    },
    players: [{ userId: "wren" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "wren" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => {
      const url = String(input);
      // The exact game URL must win over the "/api/games" list prefix.
      if (url === "/api/games/g1")
        return Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 }));
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), { status: 200 }),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  render(<App />);

  const back = await screen.findByRole("button", { name: "Back to games" });
  fireEvent.click(back);

  await screen.findByRole("heading", { name: "Open games" });
  expect(window.location.pathname).toBe("/");
});
