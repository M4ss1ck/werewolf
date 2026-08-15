import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GameId, PublicGameSummary, UserId } from "@werewolf/protocol";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";

import { api } from "../api/client.ts";
import { i18n } from "../i18n/i18n.ts";
import { CreateGameScreen } from "./create-game.tsx";
import { GamesScreen } from "./games.tsx";
import { ProfileScreen } from "./profile.tsx";
import { UsernameScreen } from "./username.tsx";

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function makeSummary(overrides: Partial<PublicGameSummary> = {}): PublicGameSummary {
  return {
    id: "g1" as GameId,
    name: "Game One",
    ownerUserId: "owner" as UserId,
    status: "lobby",
    visibility: "public",
    day: 1,
    playerCount: 0,
    players: [],
    serverNow: 1000,
    ...overrides,
  };
}

const SESSION_USER = { id: "me", username: "wren", email: "wren@example.com" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

test("username: rejects <3 chars, shows the n/24 counter, submits a trimmed value", async () => {
  const setUsername = vi
    .spyOn(api, "setUsername")
    .mockResolvedValue({ userId: "me", username: "Moonwatcher" });
  const onSaved = vi.fn();
  renderWithI18n(<UsernameScreen onSaved={onSaved} />);

  expect(screen.getByRole("heading", { name: "Choose a username" })).toBeInTheDocument();
  const input = screen.getByLabelText("Username");
  const submit = screen.getByRole("button", { name: "Save username" });
  expect(screen.getByText("0/24")).toBeInTheDocument();
  expect(submit).toBeDisabled();

  fireEvent.change(input, { target: { value: "ab" } });
  expect(screen.getByText("2/24")).toBeInTheDocument();
  expect(submit).toBeDisabled();

  fireEvent.change(input, { target: { value: "  Moonwatcher  " } });
  expect(screen.getByText("15/24")).toBeInTheDocument();
  expect(submit).toBeEnabled();

  fireEvent.click(submit);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(setUsername).toHaveBeenCalledWith("Moonwatcher");
});

test("browser: renders games, filters by status, shows the avatar stack overflow", async () => {
  const games = [
    makeSummary({
      id: "g1" as GameId,
      name: "Lobby Game",
      playerCount: 5,
      players: [
        { userId: "u1" as UserId, displayName: "Anna" },
        { userId: "u2" as UserId, displayName: "Bram" },
        { userId: "u3" as UserId, displayName: "Odile" },
        { userId: "u4" as UserId, displayName: "Mattias" },
        { userId: "u5" as UserId, displayName: "Kestrel" },
      ],
      scheduledAt: 5000,
    }),
    makeSummary({
      id: "g2" as GameId,
      name: "Running Game",
      status: "running",
      day: 3,
      playerCount: 9,
      players: [
        { userId: "u1" as UserId, displayName: "Anna" },
        { userId: "u2" as UserId, displayName: "Bram" },
        { userId: "u3" as UserId, displayName: "Odile" },
      ],
      phase: { type: "voting", endsAt: 9000 },
    }),
    makeSummary({ id: "g3" as GameId, name: "Finished Game", status: "finished", playerCount: 7 }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(games), { status: 200 })),
  );

  renderWithI18n(<GamesScreen username="Wren" />);

  expect(await screen.findByText("Lobby Game")).toBeInTheDocument();
  expect(screen.getByText("Running Game")).toBeInTheDocument();
  expect(screen.getByText("Finished Game")).toBeInTheDocument();
  // 5 players in the lobby stack: three avatars plus the overflow marker.
  expect(screen.getByText("+2")).toBeInTheDocument();
  expect(screen.getByText(/starts in/)).toBeInTheDocument();
  expect(screen.getByText(/day 3 · Voting/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Spectate" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Running" }));
  expect(screen.queryByText("Lobby Game")).not.toBeInTheDocument();
  expect(screen.queryByText("Finished Game")).not.toBeInTheDocument();
  expect(screen.getByText("Running Game")).toBeInTheDocument();

  // Lobby keeps waiting games but hides finished ones, which only All shows.
  fireEvent.click(screen.getByRole("button", { name: "Lobby" }));
  expect(screen.getByText("Lobby Game")).toBeInTheDocument();
  expect(screen.queryByText("Running Game")).not.toBeInTheDocument();
  expect(screen.queryByText("Finished Game")).not.toBeInTheDocument();
});

test("create: sends the right createGame payload including scheduledAt for a preset", async () => {
  const createGame = vi
    .spyOn(api, "createGame")
    .mockResolvedValue(makeSummary({ id: "created-1" as GameId, name: "Moonrise" }));
  renderWithI18n(<CreateGameScreen />);

  fireEvent.change(screen.getByLabelText("Game name"), { target: { value: "Moonrise" } });
  const before = Date.now();
  fireEvent.click(screen.getByRole("radio", { name: "In 5 min" }));
  fireEvent.click(screen.getByRole("button", { name: "Create game" }));
  const after = Date.now();

  await waitFor(() => expect(createGame).toHaveBeenCalledTimes(1));
  const payload = createGame.mock.calls[0]?.[0];
  expect(payload).toMatchObject({
    name: "Moonrise",
    visibility: "public",
    settings: { discussion: 120, voting: 60, night: 60, spectatingEnabled: true },
  });
  expect(payload?.scheduledAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
  expect(payload?.scheduledAt).toBeLessThanOrEqual(after + 5 * 60_000);
  expect(window.location.pathname).toBe("/games/created-1");
});

test("profile: renders the three stats and flips a toggle", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ games: 4, survived: 2, asWolf: 1 }), { status: 200 }),
      ),
  );
  renderWithI18n(<ProfileScreen onSignedOut={() => undefined} user={SESSION_USER} />);

  expect(await screen.findByText("50%")).toBeInTheDocument();
  expect(screen.getByText("4")).toBeInTheDocument();
  expect(screen.getByText("1")).toBeInTheDocument();
  expect(screen.getByText("games")).toBeInTheDocument();
  expect(screen.getByText("survived")).toBeInTheDocument();
  expect(screen.getByText("as wolf")).toBeInTheDocument();

  const notifications = screen.getByRole("switch", { name: /Phase notifications/ });
  expect(notifications).toHaveAttribute("aria-checked", "false");
  fireEvent.click(notifications);
  expect(localStorage.getItem("werewolf.prefs.notifications")).toBe("true");

  const motion = screen.getByRole("switch", { name: /Reduced motion/ });
  fireEvent.click(motion);
  expect(localStorage.getItem("werewolf.prefs.reducedMotion")).toBe("true");
  expect(document.documentElement.dataset.reducedMotion).toBe("true");
});
