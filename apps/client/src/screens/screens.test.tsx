import { readFile } from "node:fs/promises";
import {
  fireEvent,
  act as reactAct,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { en } from "@werewolf/i18n";
import type {
  ActionId,
  ChatChannel,
  EventId,
  GameId,
  PhaseId,
  PublicGameSummary,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../api/client.ts";
import { ErrorMessage } from "../components.tsx";
import { i18n } from "../i18n/i18n.ts";
import { Act } from "./act.tsx";
import { CreateGameScreen } from "./create-game.tsx";
import { GamesScreen } from "./games.tsx";
import { LobbyScreen } from "./lobby.tsx";
import { ProfileScreen } from "./profile.tsx";
import { Talk } from "./talk.tsx";
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

function makeGameSnapshot(
  overrides: Partial<Omit<ViewerGameSnapshot, "game">> & {
    game?: Partial<ViewerGameSnapshot["game"]>;
  } = {},
): ViewerGameSnapshot {
  const base: ViewerGameSnapshot = {
    game: {
      id: "g1" as GameId,
      name: "Game One",
      ownerUserId: "owner" as UserId,
      status: "running",
      day: 2,
      phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 120, voting: 60, night: 60 },
      },
    },
    players: [
      { userId: "wren" as UserId, displayName: "Wren", status: "alive" },
      { userId: "odile" as UserId, displayName: "Odile", status: "alive" },
      { userId: "mattias" as UserId, displayName: "Mattias", status: "alive" },
      { userId: "kestrel" as UserId, displayName: "Kestrel", status: "alive" },
      { userId: "anna" as UserId, displayName: "Anna", status: "alive" },
    ],
    me: { userId: "wren" as UserId, status: "alive", role: "villager" },
    availableActions: [],
    availableChannels: ["public"],
    progress: { acted: 0, eligible: 4 },
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  return { ...base, ...overrides, game: { ...base.game, ...overrides.game } };
}

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
  renderWithI18n(
    <ProfileScreen
      onSignedOut={() => undefined}
      onUsernameSaved={() => undefined}
      user={SESSION_USER}
    />,
  );

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

test("profile: edits the username", async () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    (input) =>
      Promise.resolve(
        new Response(
          String(input) === "/api/me/username"
            ? JSON.stringify({ userId: "me", username: "fox" })
            : JSON.stringify({ games: 4, survived: 2, asWolf: 1 }),
          { status: 200 },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const onUsernameSaved = vi.fn();
  renderWithI18n(
    <ProfileScreen
      onSignedOut={() => undefined}
      onUsernameSaved={onUsernameSaved}
      user={SESSION_USER}
    />,
  );

  await screen.findByText("50%");
  fireEvent.click(screen.getByRole("button", { name: /Edit username/ }));
  expect(screen.queryByText("wren@example.com")).not.toBeInTheDocument();
  const input = screen.getByLabelText("Username");
  expect(input).toHaveValue("wren");
  fireEvent.change(input, { target: { value: "fox" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(onUsernameSaved).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/me/username",
    expect.objectContaining({ method: "PATCH" }),
  );
  const patch = fetchMock.mock.calls.find((call) => call[0] === "/api/me/username");
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ username: "fox" });
});

test("profile: cancels the username edit", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ games: 4, survived: 2, asWolf: 1 }), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  renderWithI18n(
    <ProfileScreen
      onSignedOut={() => undefined}
      onUsernameSaved={() => undefined}
      user={SESSION_USER}
    />,
  );

  await screen.findByText("50%");
  fireEvent.click(screen.getByRole("button", { name: /Edit username/ }));
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "fox" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.getByText("wren@example.com")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "wren" })).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/me/username")).toHaveLength(0);
});

test("voting sends vote.set on lock", () => {
  const send = vi.fn();
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
    voteTallies: [{ targetId: "odile" as UserId, count: 1 }],
    progress: { acted: 1, eligible: 4 },
  });
  renderWithI18n(<Act events={[]} send={send} snapshot={snapshot} />);

  expect(screen.getByRole("heading", { name: "Who hangs today?" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Mattias/ }));
  fireEvent.click(screen.getByRole("button", { name: /Lock vote/ }));
  expect(send).toHaveBeenCalledWith({
    type: "vote.set",
    phaseId: 7,
    payload: { targetId: "mattias" },
  });
});

test("a disabled night target renders disabled rather than missing", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
    me: { userId: "wren" as UserId, status: "alive", role: "seer" },
    availableActions: [
      {
        id: "seer.inspect" as ActionId,
        type: "target",
        targets: [
          { userId: "odile" as UserId, enabled: true },
          { userId: "mattias" as UserId, enabled: false },
        ],
      },
    ],
  });
  renderWithI18n(<Act events={[]} send={vi.fn()} snapshot={snapshot} />);

  expect(screen.getByText("Choose a player to learn their role.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Odile/ })).toBeEnabled();
  const disabled = screen.getByRole("button", { name: /Mattias/ });
  expect(disabled).toBeInTheDocument();
  expect(disabled).toBeDisabled();
});

test("the chat composer is disabled when the viewer is dead", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
    players: [
      { userId: "wren" as UserId, displayName: "Wren", status: "dead", revealedRole: "villager" },
      { userId: "odile" as UserId, displayName: "Odile", status: "alive" },
    ],
    me: { userId: "wren" as UserId, status: "dead", role: "villager" },
  });
  renderWithI18n(<Talk events={[]} send={vi.fn()} snapshot={snapshot} />);

  expect(screen.getByLabelText(/Message/)).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("lobby owner controls appear for exactly the owner", () => {
  // The owner view loads the bot roster on mount; this test is about the
  // ownership controls, so keep it out of the network.
  vi.spyOn(api, "listBots").mockResolvedValue([]);
  const players: ViewerGameSnapshot["players"] = [
    { userId: "owner" as UserId, displayName: "Owner", status: "lobby" },
    { userId: "bob" as UserId, displayName: "Bob", status: "lobby" },
    { userId: "anna" as UserId, displayName: "Anna", status: "lobby" },
    { userId: "mattias" as UserId, displayName: "Mattias", status: "lobby" },
    { userId: "kestrel" as UserId, displayName: "Kestrel", status: "lobby" },
  ];
  const base = {
    game: {
      ownerUserId: "owner" as UserId,
      status: "lobby" as const,
      phase: null as null,
    },
    players,
  };

  // A non-owner sees no start, cancel or kick controls, only leave.
  const nonOwner = renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeGameSnapshot({
        ...base,
        me: { userId: "bob" as UserId, status: "lobby", role: "villager" },
      })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
  nonOwner.unmount();

  // The owner sees start, cancel and a kick control per other player, no
  // leave. Start now renders only for the owner (it used to render for
  // everyone, disabled).
  renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeGameSnapshot({
        ...base,
        me: { userId: "owner" as UserId, status: "lobby", role: "villager" },
      })}
    />,
  );
  expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove Bob" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove Anna" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Leave" })).not.toBeInTheDocument();
});

test("lobby: the host picks a bot from the roster, and unavailable ones are disabled", async () => {
  vi.spyOn(api, "listBots").mockResolvedValue([
    { id: "random", displayName: "Dummy", model: null, available: true },
    { id: "mira", displayName: "Mira", model: "deepseek-v4-flash", available: true },
    {
      id: "bram",
      displayName: "Bram",
      model: "glm-5",
      available: false,
      reason: "MODEL_NOT_AVAILABLE",
    },
  ]);
  const addBot = vi
    .spyOn(api, "addBot")
    .mockResolvedValue(makeGameSnapshot({ game: { status: "lobby", phase: null } }));
  renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeGameSnapshot({
        game: { ownerUserId: "owner" as UserId, status: "lobby", phase: null },
        me: { userId: "owner" as UserId, status: "lobby" },
      })}
    />,
  );

  const mira = await screen.findByRole("button", { name: /Mira/ });
  // A bot with no model says so rather than showing a blank line.
  expect(await screen.findByText("Plays at random")).toBeInTheDocument();
  // An unreachable model is offered but not clickable, with the reason shown.
  const bram = screen.getByRole("button", { name: /Bram/ });
  expect(bram).toBeDisabled();
  expect(within(bram).getByText("Model unavailable")).toBeInTheDocument();

  // Seating re-reads the roster, so let both round trips settle inside act.
  await reactAct(async () => {
    fireEvent.click(mira);
  });
  await waitFor(() => expect(addBot).toHaveBeenCalledWith(expect.anything(), "mira"));
  expect(api.listBots).toHaveBeenCalledTimes(2);
});

test("lobby: leaving takes the player back to the games list", async () => {
  // The file's afterEach resets the URL to "/", so pin it to a game route
  // first or the pathname assertion below would pass without any navigation.
  window.history.replaceState({}, "", "/games/g1");
  const leave = vi
    .spyOn(api, "leave")
    .mockResolvedValue(makeGameSnapshot({ game: { status: "lobby", phase: null } }));
  renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeGameSnapshot({
        game: { status: "lobby", phase: null },
        me: { userId: "bob" as UserId, status: "lobby" },
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Leave" }));

  await waitFor(() => expect(leave).toHaveBeenCalledWith("g1"));
  await waitFor(() => expect(window.location.pathname).toBe("/"));
});

test("action controls render from availableActions; none offered renders none even for a seer", () => {
  // The viewer's own role is seer, but the server offered no actions: nothing
  // renders. The client renders the server's action model, never its own
  // knowledge of roles.
  const noActions = renderWithI18n(
    <Act
      events={[]}
      send={() => undefined}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "alive", role: "seer" },
        availableActions: [],
      })}
    />,
  );
  expect(screen.queryByText("Choose a player to learn their role.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Odile/ })).not.toBeInTheDocument();
  noActions.unmount();

  // The same viewer with an offered action gets exactly that control.
  renderWithI18n(
    <Act
      events={[]}
      send={() => undefined}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "alive", role: "seer" },
        availableActions: [
          {
            id: "seer.inspect" as ActionId,
            type: "target",
            targets: [{ userId: "odile" as UserId, enabled: true }],
          },
        ],
      })}
    />,
  );
  expect(screen.getByText("Choose a player to learn their role.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Odile/ })).toBeInTheDocument();
});

test("the wolf chat tab appears only when the snapshot lists that channel", () => {
  const withWolfChat = renderWithI18n(
    <Talk
      events={[]}
      send={() => undefined}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
        availableChannels: ["public", "wolves"] as ChatChannel[],
      })}
    />,
  );
  expect(screen.getByRole("button", { name: "Wolf chat" })).toBeInTheDocument();
  withWolfChat.unmount();

  renderWithI18n(
    <Talk
      events={[]}
      send={() => undefined}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
        availableChannels: ["public"] as ChatChannel[],
      })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Wolf chat" })).not.toBeInTheDocument();
});

test("a dead player's revealed role shows in the list; living players show none", () => {
  renderWithI18n(
    <Act
      events={[]}
      send={() => undefined}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 },
        },
        players: [
          { userId: "wren" as UserId, displayName: "Wren", status: "alive" },
          { userId: "odile" as UserId, displayName: "Odile", status: "alive" },
          { userId: "bob" as UserId, displayName: "Bob", status: "dead", revealedRole: "werewolf" },
        ],
        me: { userId: "wren" as UserId, status: "alive", role: "seer" },
      })}
    />,
  );

  // Dead players are public: their revealed role shows next to the name.
  const deadRow = screen.getByRole("button", { name: /Bob/ });
  expect(within(deadRow).getByText(/Werewolf/)).toBeInTheDocument();

  // Living players hide their role completely.
  const livingRow = screen.getByRole("button", { name: /Odile/ });
  expect(
    within(livingRow).queryByText(/Villager|Werewolf|Mason|Seer|Cursed|Harlot|Hunter|Princess/),
  ).not.toBeInTheDocument();
});

test("an error code renders its translated message, not the code", () => {
  renderWithI18n(<ErrorMessage error={new ApiError("PHASE_CLOSED")} />);
  expect(screen.getByText("That phase has already ended.")).toBeInTheDocument();
  expect(screen.queryByText("PHASE_CLOSED")).not.toBeInTheDocument();
});

test("the voting screen renders no voter identity", () => {
  const send = vi.fn();
  // Odile leads with 3 votes, cast by Wren, Kestrel and Anna. The tally must
  // show her name and the number 3 — never who voted for her.
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
    voteTallies: [
      { targetId: "odile" as UserId, count: 3 },
      { targetId: "mattias" as UserId, count: 1 },
    ],
    progress: { acted: 4, eligible: 4 },
  });
  renderWithI18n(<Act events={[]} send={send} snapshot={snapshot} />);

  const odileRow = screen.getByRole("button", { name: /Odile/ });
  expect(within(odileRow).getByText("3")).toBeInTheDocument();
  // The mockup draws little voter avatars next to each candidate's count;
  // that is the one part of the design this screen must not reproduce.
  // No voter's display name may appear inside a candidate's row.
  expect(within(odileRow).queryByText("Wren")).not.toBeInTheDocument();
  expect(within(odileRow).queryByText("Kestrel")).not.toBeInTheDocument();
  expect(within(odileRow).queryByText("Anna")).not.toBeInTheDocument();
});

// Plural resources live under a `count` sub-key (`ui.players.count_one` /
// `_other`), so they must be called as `t("ui.players.count", { count })`.
// Calling the parent (`t("ui.players", { count })`) resolves to an object,
// which i18next renders as the raw key — a screen full of `ui.lobby.startNeeds`
// instead of "Start · needs 2". Nine call sites shipped that way once; this
// keeps them honest by checking the bundle rather than any one screen.
test("every plural key is called with its .count suffix", async () => {
  const sources = await Promise.all(
    [
      "./act.tsx",
      "./create-game.tsx",
      "./game-over.tsx",
      "./games.tsx",
      "./lobby.tsx",
      "./me.tsx",
      "./profile.tsx",
      "./talk.tsx",
      "./username.tsx",
      "./village.tsx",
      "../components.tsx",
    ].map(async (path) => {
      const url = new URL(path, import.meta.url);
      return [path, await readFile(url, "utf8")] as const;
    }),
  );

  const pluralKeys = new Set<string>();
  const collect = (node: unknown, prefix: string) => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.endsWith("_one")) pluralKeys.add(`${prefix}${key.slice(0, -"_one".length)}`);
      else collect(value, `${prefix}${key}.`);
    }
  };
  collect(en, "");
  expect(pluralKeys.size).toBeGreaterThan(0);

  const offences: string[] = [];
  for (const [path, source] of sources)
    for (const match of source.matchAll(/t\(\s*"([\w.]+)"\s*,\s*\{[^}]*\bcount\b/g)) {
      const key = match[1]!;
      // Calling the parent of a plural key is the bug; calling the key itself is correct.
      if (pluralKeys.has(`${key}.count`))
        offences.push(`${path}: t("${key}") should be "${key}.count"`);
    }
  expect(offences).toEqual([]);
});
