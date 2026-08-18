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
  GameEvent,
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
import { GameScreen } from "./game.tsx";
import { GameOverScreen } from "./game-over.tsx";
import { GamesScreen } from "./games.tsx";
import { LobbyScreen } from "./lobby.tsx";
import { ProfileScreen } from "./profile.tsx";
import { Talk } from "./talk.tsx";
import { UsernameScreen } from "./username.tsx";

// A stand-in for the game socket: the lobby now subscribes on mount, so these
// tests must not dial out, and the live-connection test needs to inspect what
// was constructed and what the socket pushed. No-op connect/close keep every
// other lobby render harmless.
const { MockLiveGameConnection } = vi.hoisted(() => {
  class MockLiveGameConnection {
    static instances: MockLiveGameConnection[] = [];
    connect = vi.fn();
    close = vi.fn();

    constructor(
      readonly gameId: string,
      readonly cursor: EventId,
      readonly handlers: {
        onSnapshot?: (snapshot: ViewerGameSnapshot) => void;
        onEvent?: (event: GameEvent) => void;
      },
    ) {
      MockLiveGameConnection.instances.push(this);
    }
  }
  return { MockLiveGameConnection };
});

vi.mock("../api/live.ts", () => ({ LiveGameConnection: MockLiveGameConnection }));

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

// A stable identity so the live effect's onUpdate dep does not churn: the
// tests push frames into re-renders, and a fresh function per render would
// rebuild the socket every time.
const noopUpdate = () => undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockLiveGameConnection.instances = [];
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

  // The browser opens on Lobby, so a running game only appears once All is picked.
  expect(await screen.findByText("Lobby Game")).toBeInTheDocument();
  expect(screen.queryByText("Running Game")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "All" }));
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
  // Send must return a promise: the lock handler swallows rejections on it.
  const send = vi.fn(() => Promise.resolve());
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

test("the lock button reports a Locked state once the shown vote is registered", () => {
  const send = vi.fn();
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
    me: {
      userId: "wren" as UserId,
      status: "alive",
      role: "villager",
      currentIntent: { vote: { type: "player", targetId: "mattias" as UserId } },
    },
    voteTallies: [{ targetId: "mattias" as UserId, count: 1 }],
    progress: { acted: 1, eligible: 4 },
  });
  renderWithI18n(<Act events={[]} send={send} snapshot={snapshot} />);

  // The server-registered vote is shown, so locking it would be a no-op.
  const locked = screen.getByRole("button", { name: "Vote locked" });
  expect(locked).toBeDisabled();
});

test("a different local pick than the registered vote keeps the lock enabled", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
    me: {
      userId: "wren" as UserId,
      status: "alive",
      role: "villager",
      currentIntent: { vote: { type: "player", targetId: "mattias" as UserId } },
    },
    voteTallies: [{ targetId: "mattias" as UserId, count: 1 }],
    progress: { acted: 1, eligible: 4 },
  });
  renderWithI18n(<Act events={[]} send={vi.fn()} snapshot={snapshot} />);

  expect(screen.getByRole("button", { name: "Vote locked" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Kestrel/ }));
  expect(screen.getByRole("button", { name: /Lock vote/ })).toBeEnabled();
});

test("an already-registered abstention locks the button too", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
    me: {
      userId: "wren" as UserId,
      status: "alive",
      role: "villager",
      currentIntent: { vote: { type: "abstain" } },
    },
    progress: { acted: 1, eligible: 4 },
  });
  renderWithI18n(<Act events={[]} send={vi.fn()} snapshot={snapshot} />);

  expect(screen.getByRole("button", { name: "Vote locked" })).toBeDisabled();
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

test("lobby: removing a bot re-reads the roster, so it can be added again", async () => {
  // The roster's availability lives on the server; the lobby must re-read it
  // after any seat change, not only after adding.
  vi.spyOn(api, "listBots")
    .mockResolvedValueOnce([
      { id: "mira", displayName: "Mira", model: "m", available: false, reason: "ALREADY_SEATED" },
    ])
    .mockResolvedValue([{ id: "mira", displayName: "Mira", model: "m", available: true }]);
  vi.spyOn(api, "kick").mockResolvedValue(
    makeGameSnapshot({ game: { status: "lobby", phase: null } }),
  );
  renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeGameSnapshot({
        game: { ownerUserId: "owner" as UserId, status: "lobby", phase: null },
        me: { userId: "owner" as UserId, status: "lobby" },
        players: [
          { userId: "owner" as UserId, displayName: "Owner", status: "lobby" },
          { userId: "bot:1" as UserId, displayName: "Mira", status: "lobby", isBot: true },
        ],
      })}
    />,
  );

  // Anchored, so this is the roster entry rather than the "Remove Mira" button.
  expect(await screen.findByRole("button", { name: /^Mira/ })).toBeDisabled();
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Remove Mira" }));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Mira/ })).toBeEnabled());
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

test("lobby: opens a live connection that delivers pushed snapshots to onUpdate", () => {
  const onUpdate = vi.fn();
  const { unmount } = renderWithI18n(
    <LobbyScreen
      onUpdate={onUpdate}
      snapshot={makeGameSnapshot({
        game: { status: "lobby", phase: null },
        me: { userId: "bob" as UserId, status: "lobby" },
      })}
    />,
  );

  // A lobby subscribes from cursor 0: it has no event history the screen
  // needs, and the sync frame's snapshot is the whole update.
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();
  expect(connection!.gameId).toBe("g1");
  expect(connection!.cursor).toBe(0 as EventId);
  expect(connection!.connect).toHaveBeenCalledTimes(1);
  expect(onUpdate).not.toHaveBeenCalled();

  // A pushed frame — the scheduled game starting — reaches App's setter.
  const running = makeGameSnapshot({ game: { status: "running" } });
  connection!.handlers.onSnapshot?.(running);
  expect(onUpdate).toHaveBeenCalledWith(running);

  // Leaving the lobby (game started, cancelled, or a manual navigate) closes
  // the socket.
  unmount();
  expect(connection!.close).toHaveBeenCalledTimes(1);
});

test("game: a chat message after the sync badges Talk until it is opened", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
  });
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  const chat = (id: number): GameEvent => ({
    id: id as EventId,
    kind: "chat.message",
    scope: "public",
    createdAt: id,
    payload: { channel: "public", text: "hello" },
  });

  // The mount-time sync frame backfills history; backlog is not "new".
  reactAct(() =>
    connection!.handlers.onEvent?.({
      id: 1 as EventId,
      kind: "phase.started",
      scope: "public",
      createdAt: 1,
      payload: { phaseId: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
    }),
  );
  // A message arriving after the sync is unseen until the tab is opened.
  reactAct(() => connection!.handlers.onEvent?.(chat(2)));

  const badge = (name: string) =>
    screen.getByRole("button", { name }).querySelector(".tabbar__badge");
  expect(badge("Talk")).not.toBeNull();
  expect(badge("Village")).toBeNull();
  expect(badge("Me")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  expect(badge("Talk")).toBeNull();
});

test("game: the Act tab badges while the viewer has no registered vote", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
  });
  const first = renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);
  expect(
    screen.getByRole("button", { name: "Act" }).querySelector(".tabbar__badge"),
  ).not.toBeNull();
  first.unmount();

  // Once a vote is registered in the snapshot the call-to-action is gone.
  renderWithI18n(
    <GameScreen
      initial={makeGameSnapshot({
        game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
        me: {
          userId: "wren" as UserId,
          status: "alive",
          role: "villager",
          currentIntent: { vote: { type: "player", targetId: "mattias" as UserId } },
        },
      })}
      onUpdate={noopUpdate}
    />,
  );
  expect(screen.getByRole("button", { name: "Act" }).querySelector(".tabbar__badge")).toBeNull();
});

test("game: the first event batch is the mount sync and never badges", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
  });
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  const chat = (id: number): GameEvent => ({
    id: id as EventId,
    kind: "chat.message",
    scope: "public",
    createdAt: id,
    payload: { channel: "public", text: "hello" },
  });

  // The first batch is the mount-time sync: it backfills history, so it must
  // not badge anything even though these are chat messages.
  reactAct(() => {
    connection!.handlers.onEvent?.(chat(1));
    connection!.handlers.onEvent?.(chat(2));
  });
  expect(screen.getByRole("button", { name: "Talk" }).querySelector(".tabbar__badge")).toBeNull();

  // A later message is unseen until the Talk tab is opened.
  reactAct(() => connection!.handlers.onEvent?.(chat(3)));
  expect(
    screen.getByRole("button", { name: "Talk" }).querySelector(".tabbar__badge"),
  ).not.toBeNull();
});

test("game: a rejected command renders the error and keeps the typed text", async () => {
  vi.spyOn(api, "postCommand").mockRejectedValue({ code: "PHASE_CLOSED" });
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
  });
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  const input = screen.getByLabelText(/Message/);
  fireEvent.change(input, { target: { value: "the deadline raced" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  expect(await screen.findByText("That phase has already ended.")).toBeInTheDocument();
  expect(input).toHaveValue("the deadline raced");
});

test("action controls render from availableActions; none offered renders none even for a seer", () => {
  // The viewer's own role is seer, but the server offered no actions: nothing
  // renders. The client renders the server's action model, never its own
  // knowledge of roles.
  const noActions = renderWithI18n(
    <Act
      events={[]}
      send={() => Promise.resolve()}
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
      send={() => Promise.resolve()}
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
      send={() => Promise.resolve()}
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
      send={() => Promise.resolve()}
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
      send={() => Promise.resolve()}
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

test("game over: a veteran win and a serial killer win each render their own title", () => {
  const veteran = renderWithI18n(
    <GameOverScreen
      events={[]}
      snapshot={makeGameSnapshot({
        game: {
          status: "finished",
          winner: {
            winningFactions: ["veteran"],
            winningPlayers: ["wren" as UserId],
            reason: "veteran_lynched",
          },
        },
      })}
    />,
  );
  expect(screen.getByRole("heading", { name: "Exactly as planned" })).toBeInTheDocument();
  expect(
    screen.getByText("The village lynched the veteran. Everyone else loses."),
  ).toBeInTheDocument();
  veteran.unmount();

  renderWithI18n(
    <GameOverScreen
      events={[]}
      snapshot={makeGameSnapshot({
        game: {
          status: "finished",
          winner: {
            winningFactions: ["serial_killer"],
            winningPlayers: ["odile" as UserId],
            reason: "serial_killer_survives",
          },
        },
      })}
    />,
  );
  expect(screen.getByRole("heading", { name: "The last one standing" })).toBeInTheDocument();
  expect(screen.getByText("The serial killer outlived everyone.")).toBeInTheDocument();
});
