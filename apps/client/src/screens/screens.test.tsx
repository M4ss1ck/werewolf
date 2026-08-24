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
  GameSummary,
  PhaseId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../api/client.ts";
import * as chatUi from "../chat/index.ts";
import type { ChatDraft, ConversationKey } from "../chat/model.ts";
import type { ConversationReadState } from "../chat/read-state.ts";
import type { ChatReadStoreController } from "../chat/read-store.ts";
import { ErrorMessage } from "../components.tsx";
import { i18n } from "../i18n/i18n.ts";
import { ToastProvider } from "../toast.tsx";
import { Act } from "./act.tsx";
import { CreateGameScreen } from "./create-game.tsx";
import { GameScreen } from "./game.tsx";
import { GameOverScreen } from "./game-over.tsx";
import { GamesScreen } from "./games.tsx";
import { LobbyScreen } from "./lobby.tsx";
import { ProfileScreen } from "./profile.tsx";
import { type GameChatRecord, Talk } from "./talk.tsx";
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
        onSync?: (snapshot: ViewerGameSnapshot, events: GameEvent[]) => void;
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

function makeSummary(overrides: Partial<GameSummary> = {}): GameSummary {
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
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  return { ...base, ...overrides, game: { ...base.game, ...overrides.game } };
}

// A stable identity so the live effect's onUpdate dep does not churn: the
// tests push frames into re-renders, and a fresh function per render would
// rebuild the socket every time.
const noopUpdate = () => undefined;

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fakeReadStore(initial: Partial<Record<ConversationKey, ConversationReadState>> = {}) {
  const calls = {
    baseline: [] as { key: string; ids: number[] }[],
    visible: [] as string[],
    through: [] as string[],
    order: [] as string[],
  };
  const states = { ...initial } as Partial<Record<ConversationKey, ConversationReadState>>;
  const store: ChatReadStoreController = {
    states,
    hasRecord: (key) => states[key] !== undefined,
    establishBaseline: (key, messages) => {
      calls.order.push(`baseline:${key}`);
      calls.baseline.push({ key, ids: messages.map((message) => message.id) });
      states[key] = { readThrough: messages.at(-1)?.id ?? 0, seenAfter: [] };
    },
    markVisible: (key) => calls.visible.push(key),
    markThrough: (key) => calls.through.push(key),
    rebaseRetention: () => undefined,
  };
  return { calls, store };
}

function talkRecords(): Record<ChatChannel, GameChatRecord> {
  const channels: ChatChannel[] = ["public", "wolves", "cult", "grave"];
  return Object.fromEntries(
    channels.map((channel) => [
      channel,
      {
        draft: { text: `${channel} draft`, mentions: [] } satisfies ChatDraft,
        jumpToLatestToken: 4,
        viewport: {
          virtuoso: { ranges: [], scrollTop: 8 },
          messageIds: [1],
          anchorId: 1,
          anchorOffset: 4,
        },
      },
    ]),
  ) as unknown as Record<ChatChannel, GameChatRecord>;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
});

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

test("browser: private games render only under All, never Lobby or Running", async () => {
  const games = [
    makeSummary({ id: "g1" as GameId, name: "Public Lobby", visibility: "public" }),
    makeSummary({ id: "g2" as GameId, name: "Private Lobby", visibility: "private" }),
    makeSummary({
      id: "g3" as GameId,
      name: "Private Running",
      visibility: "private",
      status: "running",
      day: 2,
      phase: { type: "voting", endsAt: 9000 },
    }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(games), { status: 200 })),
  );

  renderWithI18n(<GamesScreen username="Wren" />);

  // The browser opens on Lobby: a private game must not appear there.
  expect(await screen.findByText("Public Lobby")).toBeInTheDocument();
  expect(screen.queryByText("Private Lobby")).not.toBeInTheDocument();

  // Running hides private games too.
  fireEvent.click(screen.getByRole("button", { name: "Running" }));
  expect(screen.queryByText("Private Running")).not.toBeInTheDocument();

  // All shows everything, including private games.
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByText("Private Lobby")).toBeInTheDocument();
  expect(screen.getByText("Private Running")).toBeInTheDocument();
});

test("browser: private games carry a Private badge on active and finished cards", async () => {
  const games = [
    makeSummary({ id: "g1" as GameId, name: "Public Game", visibility: "public" }),
    makeSummary({
      id: "g2" as GameId,
      name: "Private Active",
      visibility: "private",
      status: "running",
      day: 2,
      phase: { type: "voting", endsAt: 9000 },
    }),
    makeSummary({
      id: "g3" as GameId,
      name: "Private Finished",
      visibility: "private",
      status: "finished",
      playerCount: 7,
    }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(games), { status: 200 })),
  );

  renderWithI18n(<GamesScreen username="Wren" />);

  // The browser opens on Lobby: only the public game is visible, no badges.
  expect(await screen.findByText("Public Game")).toBeInTheDocument();
  expect(screen.queryByText("Private")).not.toBeInTheDocument();

  // All shows every game; exactly the two private ones carry the badge.
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByText("Private Active")).toBeInTheDocument();
  expect(screen.getByText("Private Finished")).toBeInTheDocument();
  expect(screen.getAllByText("Private")).toHaveLength(2);
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

test("lobby: a seated bot fills its seat before the server answers", async () => {
  vi.spyOn(api, "listBots").mockResolvedValue([
    { id: "mira", displayName: "Mira", model: "deepseek-v4-flash", available: true },
  ]);
  // Hold the round trip open, so the assertions land on the optimistic seat
  // rather than on the snapshot the request eventually returns.
  let seat: (snapshot: ViewerGameSnapshot) => void = () => undefined;
  vi.spyOn(api, "addBot").mockReturnValue(
    new Promise<ViewerGameSnapshot>((resolve) => {
      seat = resolve;
    }),
  );
  renderWithI18n(
    <LobbyScreen
      onUpdate={noopUpdate}
      snapshot={makeGameSnapshot({
        game: { ownerUserId: "owner" as UserId, status: "lobby", phase: null },
        me: { userId: "owner" as UserId, status: "lobby" },
        players: [{ userId: "owner" as UserId, displayName: "Owner", status: "lobby" }],
      })}
    />,
  );

  expect(await screen.findByText("1 / 5")).toBeInTheDocument();
  const mira = screen.getByRole("button", { name: /^Mira/ });
  await reactAct(async () => {
    fireEvent.click(mira);
  });

  // The seat is taken and the roster entry unclickable while the request runs.
  expect(screen.getByText("2 / 5")).toBeInTheDocument();
  expect(within(screen.getByRole("list")).getByText("Mira")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Mira/ })).toBeDisabled();

  // Once the server answers, the optimistic seat gives way to the snapshot.
  await reactAct(async () => {
    seat(makeGameSnapshot({ game: { status: "lobby", phase: null } }));
  });
  await waitFor(() => expect(screen.getByText("1 / 5")).toBeInTheDocument());
});

test("lobby: a rejected bot gives its seat back and reports the error", async () => {
  vi.spyOn(api, "listBots").mockResolvedValue([
    { id: "mira", displayName: "Mira", model: "deepseek-v4-flash", available: true },
  ]);
  vi.spyOn(api, "addBot").mockRejectedValue(new ApiError("GAME_ALREADY_STARTED"));
  renderWithI18n(
    <LobbyScreen
      onUpdate={noopUpdate}
      snapshot={makeGameSnapshot({
        game: { ownerUserId: "owner" as UserId, status: "lobby", phase: null },
        me: { userId: "owner" as UserId, status: "lobby" },
        players: [{ userId: "owner" as UserId, displayName: "Owner", status: "lobby" }],
      })}
    />,
  );

  const mira = await screen.findByRole("button", { name: /^Mira/ });
  await reactAct(async () => {
    fireEvent.click(mira);
  });

  expect(screen.getByText("1 / 5")).toBeInTheDocument();
  expect(within(screen.getByRole("list")).queryByText("Mira")).not.toBeInTheDocument();
  expect(screen.getByText(en.errors.GAME_ALREADY_STARTED)).toBeInTheDocument();
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

test("game: a chat message keeps the numeric Talk badge until its row is visible", () => {
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
    actorUserId: "odile" as UserId,
    createdAt: id,
    payload: { channel: "public", text: "hello", mentions: [] },
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
    screen
      .getByRole("button", { name: name === "Talk" ? /^Talk/ : name })
      .querySelector(".tabbar__badge");
  expect(badge("Talk")).not.toBeNull();
  expect(badge("Village")).toBeNull();
  expect(badge("Me")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /^Talk/ }));
  expect(badge("Talk")).not.toBeNull();
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
    actorUserId: "odile" as UserId,
    createdAt: id,
    payload: { channel: "public", text: "hello", mentions: [] },
  });

  // The first batch is the mount-time sync: it backfills history, so it must
  // not badge anything even though these are chat messages.
  reactAct(() => {
    connection!.handlers.onEvent?.(chat(1));
    connection!.handlers.onEvent?.(chat(2));
  });
  expect(screen.getByRole("button", { name: /^Talk/ }).querySelector(".tabbar__badge")).toBeNull();

  // A later message is unseen until the Talk tab is opened.
  reactAct(() => connection!.handlers.onEvent?.(chat(3)));
  expect(
    screen.getByRole("button", { name: /^Talk/ }).querySelector(".tabbar__badge"),
  ).not.toBeNull();
});

test("game: atomic sync deduplicates and baselines complete newly available history before update", () => {
  const initial = makeGameSnapshot();
  const next = makeGameSnapshot({
    players: initial.players.map((player) =>
      player.userId === "wren" ? { ...player, status: "dead" as const } : player,
    ),
    me: { ...initial.me!, status: "dead" },
    availableChannels: ["public", "grave"],
  });
  const read = fakeReadStore();
  const onUpdate = vi.fn(() => read.calls.order.push("update"));
  renderWithI18n(<GameScreen initial={initial} onUpdate={onUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  const publicChat = (text: string): GameEvent => ({
    id: 5 as EventId,
    kind: "chat.message",
    scope: "public",
    actorUserId: "odile" as UserId,
    createdAt: 5,
    payload: { channel: "public", text, mentions: [] },
  });
  const graveChat: GameEvent = {
    id: 7 as EventId,
    kind: "chat.message",
    scope: "faction",
    scopeId: "grave",
    actorUserId: "mattias" as UserId,
    createdAt: 7,
    payload: { channel: "grave", text: "old grave", mentions: [] },
  };
  const nonChat: GameEvent = {
    id: 3 as EventId,
    kind: "player.eliminated",
    scope: "public",
    actorUserId: "odile" as UserId,
    createdAt: 3,
    payload: { playerId: "wren" as UserId, role: "villager", cause: "day_vote" },
  };

  reactAct(() =>
    connection!.handlers.onSync?.(next, [nonChat, graveChat, publicChat("old"), publicChat("new")]),
  );

  expect(read.calls.baseline).toEqual([
    { key: "game:g1:public", ids: [5] },
    { key: "game:g1:grave", ids: [7] },
  ]);
  expect(read.calls.order).toEqual(["baseline:game:g1:public", "baseline:game:g1:grave", "update"]);
  expect(onUpdate).toHaveBeenCalledWith(next);

  reactAct(() =>
    connection!.handlers.onSync?.(next, [graveChat, publicChat("duplicate backfill")]),
  );
  expect(read.calls.baseline).toHaveLength(2);
  expect(onUpdate).toHaveBeenCalledTimes(2);
});

test("game: atomic sync preserves an existing read record and baselines only a new channel", () => {
  const initial = makeGameSnapshot();
  const publicKey = "game:g1:public" as ConversationKey;
  const next = makeGameSnapshot({
    players: initial.players.map((player) =>
      player.userId === "wren" ? { ...player, status: "dead" as const } : player,
    ),
    me: { ...initial.me!, status: "dead" },
    availableChannels: ["public", "grave"],
  });
  const read = fakeReadStore({ [publicKey]: { readThrough: 2, seenAfter: [3] } });
  renderWithI18n(<GameScreen initial={initial} onUpdate={noopUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  const events: GameEvent[] = [
    {
      id: 5 as EventId,
      kind: "chat.message",
      scope: "public",
      actorUserId: "odile" as UserId,
      createdAt: 5,
      payload: { channel: "public", text: "new public", mentions: [] },
    },
    {
      id: 7 as EventId,
      kind: "chat.message",
      scope: "faction",
      scopeId: "grave",
      actorUserId: "mattias" as UserId,
      createdAt: 7,
      payload: { channel: "grave", text: "old grave", mentions: [] },
    },
  ];
  reactAct(() => connection!.handlers.onSync?.(next, events));

  expect(read.calls.baseline).toEqual([{ key: "game:g1:grave", ids: [7] }]);
  expect(read.store.states[publicKey]).toEqual({ readThrough: 2, seenAfter: [3] });
});

test("game: four channel drafts survive Talk chip and Village/Act/Me navigation, then reset on remount", () => {
  const snapshot = makeGameSnapshot({
    availableChannels: ["public", "wolves", "cult", "grave"],
  });
  const view = renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);
  fireEvent.click(screen.getByRole("button", { name: "Talk" }));

  const drafts: Record<ChatChannel, string> = {
    public: "public draft",
    wolves: "wolves draft",
    cult: "cult draft",
    grave: "grave draft",
  };
  for (const [channel, text] of Object.entries(drafts) as [ChatChannel, string][]) {
    const labels: Record<ChatChannel, string> = {
      public: "Public chat",
      wolves: "Wolf chat",
      cult: "Cult chat",
      grave: "Grave chat",
    };
    fireEvent.click(screen.getByRole("button", { name: labels[channel] }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  }

  fireEvent.click(screen.getByRole("button", { name: "Village" }));
  fireEvent.click(screen.getByRole("button", { name: "Act" }));
  fireEvent.click(screen.getByRole("button", { name: "Me" }));
  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  const labels: Record<ChatChannel, string> = {
    public: "Public chat",
    wolves: "Wolf chat",
    cult: "Cult chat",
    grave: "Grave chat",
  };
  for (const [channel, text] of Object.entries(drafts) as [ChatChannel, string][]) {
    fireEvent.click(screen.getByRole("button", { name: labels[channel] }));
    expect(screen.getByLabelText("Message")).toHaveValue(text);
  }

  view.unmount();
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);
  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  expect(screen.getByLabelText("Message")).toHaveValue("");
});

test("game: unavailable selected channel falls back without deleting its draft", () => {
  const initial = makeGameSnapshot({ availableChannels: ["public", "wolves"] });
  const unavailable = makeGameSnapshot({ availableChannels: ["public"] });
  const availableAgain = makeGameSnapshot({ availableChannels: ["public", "wolves"] });
  renderWithI18n(<GameScreen initial={initial} onUpdate={noopUpdate} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  fireEvent.click(screen.getByRole("button", { name: "Wolf chat" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "keep this" } });

  reactAct(() => connection!.handlers.onSync?.(unavailable, []));
  expect(screen.getByRole("button", { name: "Public chat" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByRole("button", { name: "Wolf chat" })).not.toBeInTheDocument();

  reactAct(() => connection!.handlers.onSync?.(availableAgain, []));
  fireEvent.click(screen.getByRole("button", { name: "Wolf chat" }));
  expect(screen.getByLabelText("Message")).toHaveValue("keep this");
});

test("game: Talk aggregates only available channel unread counts and keeps its badge active", () => {
  const publicKey = "game:g1:public" as ConversationKey;
  const wolvesKey = "game:g1:wolves" as ConversationKey;
  const read = fakeReadStore({
    [publicKey]: { readThrough: 0, seenAfter: [] },
    [wolvesKey]: { readThrough: 0, seenAfter: [] },
  });
  const snapshot = makeGameSnapshot({
    me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
    availableChannels: ["public", "wolves"] as ChatChannel[],
    knownChannelMemberIds: { wolves: ["odile" as UserId] },
  });
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();
  const events: GameEvent[] = [
    {
      id: 5 as EventId,
      kind: "chat.message",
      scope: "public",
      actorUserId: "odile" as UserId,
      createdAt: 5,
      payload: {
        channel: "public",
        text: "@Wren",
        mentions: [{ userId: "wren" as UserId, start: 0, length: 5 }],
      },
    },
    {
      id: 6 as EventId,
      kind: "chat.message",
      scope: "faction",
      scopeId: "wolves",
      actorUserId: "odile" as UserId,
      createdAt: 6,
      payload: { channel: "wolves", text: "howl", mentions: [] },
    },
  ];
  reactAct(() => connection!.handlers.onSync?.(snapshot, events));

  const talk = screen.getByRole("button", { name: "Talk, 2, Mentioned you" });
  expect(talk.querySelector(".tabbar__badge")).toHaveTextContent("2");
  fireEvent.click(talk);
  expect(screen.getByRole("button", { name: "Talk, 2, Mentioned you" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Public chat, 1, Mentioned you/ })).toHaveTextContent(
    "@",
  );
  expect(screen.getByRole("button", { name: "Wolf chat, 1" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Cult chat|Grave chat/ })).not.toBeInTheDocument();
  expect(read.calls.visible).toEqual([]);
});

test("game: a rejected command renders the error and keeps the typed text", async () => {
  vi.spyOn(api, "postCommand").mockRejectedValue({ code: "PHASE_CLOSED" });
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
  });
  renderWithI18n(
    <ToastProvider>
      <GameScreen initial={snapshot} onUpdate={noopUpdate} />
    </ToastProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  const input = screen.getByLabelText(/Message/);
  fireEvent.change(input, { target: { value: "the deadline raced" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  expect(await screen.findByText("That phase has already ended.")).toBeInTheDocument();
  expect(input).toHaveValue("the deadline raced");
});

test("game: a failed send does not let a later remote row consume stale pending state", async () => {
  const jumps = vi.fn();
  vi.spyOn(chatUi, "ChatList").mockImplementation((props) => {
    const previousToken = useRef(props.jumpToLatestToken);
    useEffect(() => {
      if (props.jumpToLatestToken !== previousToken.current && props.messages.length > 0) jumps();
      previousToken.current = props.jumpToLatestToken;
    }, [props.jumpToLatestToken, props.messages.length]);
    return <div data-testid="jump-probe" />;
  });
  vi.spyOn(api, "postCommand").mockRejectedValue({ code: "PHASE_CLOSED" });
  const read = fakeReadStore();
  const snapshot = makeGameSnapshot();
  renderWithI18n(
    <ToastProvider>
      <GameScreen initial={snapshot} onUpdate={noopUpdate} readStore={read.store} />
    </ToastProvider>,
  );
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "failed message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("That phase has already ended.");
  expect(input).toHaveValue("failed message");

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 5 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "odile" as UserId,
        createdAt: 5,
        payload: { channel: "public", text: "remote after failure", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual([]);
  expect(jumps).not.toHaveBeenCalled();
  expect(input).toHaveValue("failed message");
});

test("game: a sync echo after the HTTP response clears and marks only its channel", async () => {
  vi.spyOn(api, "postCommand").mockResolvedValue(undefined);
  const read = fakeReadStore();
  const snapshot = makeGameSnapshot({ availableChannels: ["public", "wolves"] });
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello village" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 5 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "wren" as UserId,
        createdAt: 5,
        payload: { channel: "public", text: "hello village", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual(["game:g1:public"]);
  expect(read.calls.through).not.toContain("game:g1:wolves");
});

test("game: a sync echo marks on the row, and the settling post adds no further mark", async () => {
  let resolvePost: (() => void) | undefined;
  const post = vi.spyOn(api, "postCommand").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolvePost = resolve;
      }),
  );
  const read = fakeReadStore();
  const snapshot = makeGameSnapshot({ availableChannels: ["public", "wolves"] });
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello before ack" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 6 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "wren" as UserId,
        createdAt: 6,
        payload: { channel: "public", text: "hello before ack", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual(["game:g1:public"]);

  // The echo also requests a jump to latest, and a jump marks through the row
  // it lands on, one animation frame later. Wait for that second mark instead
  // of racing it: on a fast machine the post below settles first and the frame
  // never counted, which is the only reason this once read as a single mark.
  await waitFor(() => expect(read.calls.through).toHaveLength(2));
  const afterEcho = [...read.calls.through];

  resolvePost?.();
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
  expect(read.calls.through).toEqual(afterEcho);
  expect(read.calls.through).not.toContain("game:g1:wolves");
});

test("game: a sync-before-HTTP echo performs one actual jump and never jumps twice", async () => {
  const jumps = vi.fn();
  vi.spyOn(chatUi, "ChatList").mockImplementation((props) => {
    const previousToken = useRef(props.jumpToLatestToken);
    useEffect(() => {
      if (props.jumpToLatestToken !== previousToken.current && props.messages.length > 0) jumps();
      previousToken.current = props.jumpToLatestToken;
    }, [props.jumpToLatestToken, props.messages.length]);
    return <div data-testid="jump-probe" />;
  });

  let resolvePost: (() => void) | undefined;
  const post = vi.spyOn(api, "postCommand").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolvePost = resolve;
      }),
  );
  const snapshot = makeGameSnapshot();
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "jump once" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 6 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "wren" as UserId,
        createdAt: 6,
        payload: { channel: "public", text: "jump once", mentions: [] },
      },
    ]),
  );
  await waitFor(() => expect(jumps).toHaveBeenCalledTimes(1));
  resolvePost?.();
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
  expect(jumps).toHaveBeenCalledTimes(1);
});

test("game: overlapping sends ignore remote rows and resolve each own echo", async () => {
  const jumps = vi.fn();
  vi.spyOn(chatUi, "ChatList").mockImplementation((props) => {
    const previousToken = useRef(props.jumpToLatestToken);
    const previousLatest = useRef(props.messages.at(-1)?.id);
    const pendingJump = useRef(false);
    useEffect(() => {
      const latest = props.messages.at(-1)?.id;
      const appendedLatest =
        previousLatest.current !== undefined &&
        latest !== undefined &&
        latest > previousLatest.current;
      if (props.jumpToLatestToken !== previousToken.current) {
        previousToken.current = props.jumpToLatestToken;
        if (appendedLatest) jumps();
        else pendingJump.current = true;
      } else if (pendingJump.current && appendedLatest) {
        pendingJump.current = false;
        jumps();
      }
      previousLatest.current = latest;
    }, [props.jumpToLatestToken, props.messages]);
    return <div data-testid="jump-probe" />;
  });
  let resolveSecond: (() => void) | undefined;
  const post = vi
    .spyOn(api, "postCommand")
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve;
        }),
    );
  const read = fakeReadStore();
  const snapshot = makeGameSnapshot();
  renderWithI18n(<GameScreen initial={snapshot} onUpdate={noopUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 1 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "odile" as UserId,
        createdAt: 1,
        payload: { channel: "public", text: "existing history", mentions: [] },
      },
    ]),
  );
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "first own message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(input).toHaveValue(""));

  fireEvent.change(input, { target: { value: "second own message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post).toHaveBeenNthCalledWith(
    1,
    "g1",
    expect.objectContaining({ payload: expect.objectContaining({ text: "first own message" }) }),
  );
  expect(post).toHaveBeenNthCalledWith(
    2,
    "g1",
    expect.objectContaining({ payload: expect.objectContaining({ text: "second own message" }) }),
  );

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 5 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "odile" as UserId,
        createdAt: 5,
        payload: { channel: "public", text: "remote between sends", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual([]);
  expect(jumps).not.toHaveBeenCalled();

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 6 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "wren" as UserId,
        createdAt: 6,
        payload: { channel: "public", text: "first own message", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual(["game:g1:public"]);
  await waitFor(() => expect(jumps).toHaveBeenCalledTimes(1));

  reactAct(() =>
    connection!.handlers.onSync?.(snapshot, [
      {
        id: 7 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "wren" as UserId,
        createdAt: 7,
        payload: { channel: "public", text: "second own message", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual(["game:g1:public", "game:g1:public"]);
  await waitFor(() => expect(jumps).toHaveBeenCalledTimes(2));

  resolveSecond?.();
  await waitFor(() => expect(input).toHaveValue(""));
});

test("game: an authoritative resync removes stale rows before cursor-zero history returns", async () => {
  vi.spyOn(api, "postCommand").mockResolvedValue(undefined);
  const read = fakeReadStore();
  const initial = makeGameSnapshot({ cursor: 40 as EventId });
  renderWithI18n(<GameScreen initial={initial} onUpdate={noopUpdate} readStore={read.store} />);
  const connection = MockLiveGameConnection.instances[0];
  expect(connection).toBeDefined();

  const stale = {
    id: 40 as EventId,
    kind: "chat.message" as const,
    scope: "public" as const,
    actorUserId: "odile" as UserId,
    createdAt: 40,
    payload: { channel: "public" as const, text: "stale", mentions: [] },
  };
  reactAct(() => connection!.handlers.onSync?.(initial, [stale]));

  const fresh = makeGameSnapshot({
    cursor: 10 as EventId,
    players: initial.players.map((player) =>
      player.userId === "wren" ? { ...player, status: "dead" as const } : player,
    ),
    me: { ...initial.me!, status: "alive" },
    availableChannels: ["public", "grave"],
  });
  reactAct(() => connection!.handlers.onSnapshot?.(fresh));
  reactAct(() =>
    connection!.handlers.onSync?.(fresh, [
      {
        id: 11 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "odile" as UserId,
        createdAt: 11,
        payload: { channel: "public", text: "fresh", mentions: [] },
      },
      {
        id: 12 as EventId,
        kind: "chat.message",
        scope: "faction",
        scopeId: "grave",
        actorUserId: "mattias" as UserId,
        createdAt: 12,
        payload: { channel: "grave", text: "new grave", mentions: [] },
      },
    ]),
  );
  expect(read.calls.baseline).toContainEqual({ key: "game:g1:grave", ids: [12] });

  fireEvent.click(screen.getByRole("button", { name: "Talk" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "after resync" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
  reactAct(() =>
    connection!.handlers.onSync?.(fresh, [
      {
        id: 13 as EventId,
        kind: "chat.message",
        scope: "public",
        actorUserId: "wren" as UserId,
        createdAt: 13,
        payload: { channel: "public", text: "after resync", mentions: [] },
      },
    ]),
  );
  expect(read.calls.through).toEqual(["game:g1:public"]);
});

test("Talk keeps the public composer read-only at night and for spectators", () => {
  const night = renderWithI18n(
    <Talk
      events={[]}
      send={vi.fn()}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
      })}
    />,
  );
  expect(screen.getByLabelText("Message")).toBeDisabled();
  night.unmount();

  renderWithI18n(
    <Talk
      events={[]}
      send={vi.fn()}
      snapshot={makeGameSnapshot({
        me: { userId: "spectator" as UserId, status: "spectator" },
      })}
    />,
  );
  expect(screen.getByLabelText("Message")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("controlled Talk preserves the exact channel draft and viewport when sending fails", async () => {
  const initialRecords = talkRecords();
  let currentRecords = initialRecords;
  const onDraftChange = vi.fn((draft: ChatDraft) => {
    currentRecords = {
      ...currentRecords,
      wolves: { ...currentRecords.wolves, draft },
    };
  });
  const onError = vi.fn();
  const snapshot = makeGameSnapshot({
    me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
    availableChannels: ["public", "wolves"],
  });
  renderWithI18n(
    <Talk
      activeChannel="wolves"
      chatRows={{ public: [], wolves: [], cult: [], grave: [] }}
      onDraftChange={onDraftChange}
      onError={onError}
      onSend={vi.fn().mockRejectedValue(new ApiError("PHASE_CLOSED"))}
      records={currentRecords}
      snapshot={snapshot}
    />,
  );

  const before = currentRecords.wolves;
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(onDraftChange).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Message")).toHaveValue("wolves draft");
  expect(currentRecords.wolves).toBe(before);
  expect(currentRecords.wolves.viewport).toEqual(before.viewport);
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

test("discussion: offered day actions render; none offered renders no action controls", () => {
  const withActions = renderWithI18n(
    <Act
      events={[]}
      send={() => Promise.resolve()}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "mayor" },
        availableActions: [
          {
            id: "mayor.reveal" as ActionId,
            type: "target",
            targets: [
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
          },
          { id: "mayor.pardon" as ActionId, type: "choice" },
        ],
      })}
    />,
  );
  // The target action renders a player picker, the choice action a toggle.
  expect(screen.getByRole("heading", { name: /vote no longer decides/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Odile/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reveal and pardon" })).toBeInTheDocument();
  withActions.unmount();

  renderWithI18n(
    <Act
      events={[]}
      send={() => Promise.resolve()}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "mayor" },
        availableActions: [],
      })}
    />,
  );
  expect(screen.getByText("Nothing to do today.")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("discussion: picking a target for mayor.reveal posts day.action.set with that targetId", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "mayor" },
        availableActions: [
          {
            id: "mayor.reveal" as ActionId,
            type: "target",
            targets: [
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
          },
          { id: "mayor.pardon" as ActionId, type: "choice" },
        ],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm · Odile/ }));
  expect(send).toHaveBeenCalledWith({
    type: "day.action.set",
    phaseId: 1,
    payload: { action: "mayor.reveal", targetId: "odile" },
  });
});

test("discussion: mayor.pardon posts day.action.set with no targetId", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "mayor" },
        availableActions: [{ id: "mayor.pardon" as ActionId, type: "choice" }],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Reveal and pardon" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm · Reveal and pardon/ }));
  expect(send).toHaveBeenCalledWith({
    type: "day.action.set",
    phaseId: 1,
    payload: { action: "mayor.pardon" },
  });
});

test("voting: the vote list and the offered day actions both render", () => {
  renderWithI18n(
    <Act
      events={[]}
      send={() => Promise.resolve()}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "mayor" },
        availableActions: [
          {
            id: "mayor.reveal" as ActionId,
            type: "target",
            targets: [{ userId: "odile" as UserId, enabled: true }],
          },
          { id: "mayor.pardon" as ActionId, type: "choice" },
        ],
      })}
    />,
  );

  // The vote list is untouched...
  expect(screen.getByRole("heading", { name: "Who hangs today?" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Abstain" })).toBeInTheDocument();
  // ...and the offered day actions render alongside it.
  expect(screen.getByRole("heading", { name: /vote no longer decides/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reveal and pardon" })).toBeInTheDocument();
});

test("night regression: the night branch still renders its actions and posts night.action.set", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
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
  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm · Odile/ }));
  // The command type must stay night.action.set: a night action sent as
  // day.action.set would be silently rejected by the server.
  expect(send).toHaveBeenCalledWith({
    type: "night.action.set",
    phaseId: 2,
    payload: { action: "seer.inspect", targetId: "odile" },
  });
});

test("night: a wolf sees which pack member picked which target on the attack rows", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
        availableActions: [
          {
            id: "wolf.attack" as ActionId,
            type: "target",
            targets: [
              { userId: "odile" as UserId, enabled: true },
              { userId: "kestrel" as UserId, enabled: true },
            ],
          },
        ],
        packBallot: [{ playerId: "mattias" as UserId, targetId: "odile" as UserId }],
      })}
    />,
  );

  const odileRow = screen.getByRole("button", { name: /Odile/ });
  expect(within(odileRow).getByText("Mattias")).toBeInTheDocument();
});

test("night: without a packBallot no picker names are rendered", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
        availableActions: [
          {
            id: "wolf.attack" as ActionId,
            type: "target",
            targets: [
              { userId: "odile" as UserId, enabled: true },
              { userId: "kestrel" as UserId, enabled: true },
            ],
          },
        ],
      })}
    />,
  );

  expect(screen.queryByText("Mattias")).not.toBeInTheDocument();
});

test("targets: a count-2 action renders its rows, including the viewer's own row", () => {
  renderWithI18n(
    <Act
      events={[]}
      send={() => Promise.resolve()}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "cupid" },
        availableActions: [
          {
            id: "cupid.link" as ActionId,
            type: "targets",
            count: 2,
            targets: [
              { userId: "wren" as UserId, enabled: true },
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
          },
        ],
      })}
    />,
  );

  expect(
    screen.getByText("Choose two players whose lives will be bound together."),
  ).toBeInTheDocument();
  // The viewer may be in their own target list; the row must still render.
  expect(screen.getByRole("button", { name: /Wren/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Odile/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Mattias/ })).toBeInTheDocument();
});

test("targets: picking one target sends nothing", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "cupid" },
        availableActions: [
          {
            id: "cupid.link" as ActionId,
            type: "targets",
            count: 2,
            targets: [
              { userId: "wren" as UserId, enabled: true },
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
          },
        ],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  // A partial selection never submits and offers no confirm.
  expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});

test("targets: picking two enables confirm and posts night.action.set with targetIds", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "cupid" },
        availableActions: [
          {
            id: "cupid.link" as ActionId,
            type: "targets",
            count: 2,
            targets: [
              { userId: "wren" as UserId, enabled: true },
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
          },
        ],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mattias/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(send).toHaveBeenCalledWith({
    type: "night.action.set",
    phaseId: 2,
    payload: { action: "cupid.link", targetIds: ["odile", "mattias"] },
  });
});

test("targets: at cap a third row is not selectable; un-picking frees a slot", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "cupid" },
        availableActions: [
          {
            id: "cupid.link" as ActionId,
            type: "targets",
            count: 2,
            targets: [
              { userId: "wren" as UserId, enabled: true },
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
          },
        ],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  fireEvent.click(screen.getByRole("button", { name: /Mattias/ }));
  // Both slots are full, so the remaining row is not selectable.
  expect(screen.getByRole("button", { name: /Wren/ })).toBeDisabled();
  // Un-picking one frees a slot for the third row.
  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  expect(screen.getByRole("button", { name: /Wren/ })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /Wren/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(send).toHaveBeenCalledWith({
    type: "night.action.set",
    phaseId: 2,
    payload: { action: "cupid.link", targetIds: ["mattias", "wren"] },
  });
});

test("targets: a disabled target cannot be picked", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "cupid" },
        availableActions: [
          {
            id: "cupid.link" as ActionId,
            type: "targets",
            count: 2,
            targets: [
              { userId: "wren" as UserId, enabled: true },
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: false },
            ],
          },
        ],
      })}
    />,
  );

  const disabled = screen.getByRole("button", { name: /Mattias/ });
  expect(disabled).toBeDisabled();
  fireEvent.click(disabled);
  expect(send).not.toHaveBeenCalled();
});

test("targets: selectedTargetIds from the server pre-seeds the selection", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "cupid" },
        availableActions: [
          {
            id: "cupid.link" as ActionId,
            type: "targets",
            count: 2,
            targets: [
              { userId: "wren" as UserId, enabled: true },
              { userId: "odile" as UserId, enabled: true },
              { userId: "mattias" as UserId, enabled: true },
            ],
            selectedTargetIds: ["odile" as UserId, "mattias" as UserId],
          },
        ],
      })}
    />,
  );

  expect(screen.getByRole("button", { name: /Odile/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /Mattias/ })).toHaveAttribute("aria-pressed", "true");
  // The pre-seeded pair is already complete, so confirm is available at once.
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(send).toHaveBeenCalledWith({
    type: "night.action.set",
    phaseId: 2,
    payload: { action: "cupid.link", targetIds: ["odile", "mattias"] },
  });
});

test("regression: single-target and choice actions keep their payload shape", () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Act
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "seer" },
        availableActions: [
          {
            id: "seer.inspect" as ActionId,
            type: "target",
            targets: [{ userId: "odile" as UserId, enabled: true }],
          },
          { id: "harlot.stay" as ActionId, type: "choice" },
        ],
      })}
    />,
  );

  // Single-target: posts targetId, never targetIds.
  fireEvent.click(screen.getByRole("button", { name: /Odile/ }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm · Odile/ }));
  expect(send).toHaveBeenCalledWith({
    type: "night.action.set",
    phaseId: 2,
    payload: { action: "seer.inspect", targetId: "odile" },
  });

  // Choice: posts no target field at all.
  fireEvent.click(screen.getByRole("button", { name: "Stay home" }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm · Stay home/ }));
  expect(send).toHaveBeenCalledWith({
    type: "night.action.set",
    phaseId: 2,
    payload: { action: "harlot.stay" },
  });
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

test("the grave chip appears only when the snapshot lists that channel", () => {
  const withGraveChat = renderWithI18n(
    <Talk
      events={[]}
      send={() => Promise.resolve()}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "dead", role: "villager" },
        availableChannels: ["public", "grave"] as ChatChannel[],
      })}
    />,
  );
  expect(screen.getByRole("button", { name: "Grave chat" })).toBeInTheDocument();
  withGraveChat.unmount();

  renderWithI18n(
    <Talk
      events={[]}
      send={() => Promise.resolve()}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "dead", role: "villager" },
        availableChannels: ["public"] as ChatChannel[],
      })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Grave chat" })).not.toBeInTheDocument();
});

test("sending on the grave channel posts chat.send with channel grave", async () => {
  const send = vi.fn(() => Promise.resolve());
  renderWithI18n(
    <Talk
      events={[]}
      send={send}
      snapshot={makeGameSnapshot({
        game: {
          phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        me: { userId: "wren" as UserId, status: "dead", role: "villager" },
        availableChannels: ["public", "grave"] as ChatChannel[],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Grave chat" }));
  fireEvent.change(screen.getByLabelText(/Message/), { target: { value: "rest well" } });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });

  expect(send).toHaveBeenCalledWith({
    type: "chat.send",
    phaseId: 1,
    payload: { channel: "grave", text: "rest well", mentions: [] },
  });
});

test("controlled Talk sends the current channel with canonical mentions", async () => {
  const sent: { channel: ChatChannel; text: string; mentions: unknown[] }[] = [];
  const snapshot = makeGameSnapshot({
    me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
    availableChannels: ["public", "wolves"] as ChatChannel[],
    knownChannelMemberIds: { wolves: ["odile" as UserId] },
  });
  const rows = { public: [], wolves: [], cult: [], grave: [] } as Record<ChatChannel, never[]>;

  function Harness() {
    const [activeChannel, setActiveChannel] = useState<ChatChannel>("public");
    const [records, setRecords] = useState(talkRecords());
    return (
      <Talk
        activeChannel={activeChannel}
        chatRows={rows}
        onChannelChange={setActiveChannel}
        onDraftChange={(draft) =>
          setRecords((current) => ({
            ...current,
            [activeChannel]: { ...current[activeChannel], draft },
          }))
        }
        onSend={async (content) => {
          sent.push({ channel: activeChannel, ...content });
        }}
        records={records}
        snapshot={snapshot}
      />
    );
  }

  renderWithI18n(<Harness />);
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "@Od" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyUp(input, { key: "Enter" });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
  expect(sent[0]).toEqual({
    channel: "public",
    text: "@Odile",
    mentions: [{ userId: "odile", start: 0, length: 6 }],
  });

  fireEvent.click(screen.getByRole("button", { name: "Wolf chat" }));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "secret" } });
  await reactAct(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
  expect(sent[1]).toEqual({ channel: "wolves", text: "secret", mentions: [] });
});

test("a dead viewer can type on the grave channel during the night phase", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 2 as PhaseId, type: "night", startedAt: 1000, endsAt: 10_000 } },
    players: [
      { userId: "wren" as UserId, displayName: "Wren", status: "dead", revealedRole: "villager" },
      { userId: "odile" as UserId, displayName: "Odile", status: "alive" },
    ],
    me: { userId: "wren" as UserId, status: "dead", role: "villager" },
    availableChannels: ["public", "grave"] as ChatChannel[],
  });
  renderWithI18n(<Talk events={[]} send={() => Promise.resolve()} snapshot={snapshot} />);

  // Public chat is silenced at night even for the dead; the grave is not.
  expect(screen.getByLabelText(/Message/)).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Grave chat" }));
  expect(screen.getByLabelText(/Message/)).toBeEnabled();
  fireEvent.change(screen.getByLabelText(/Message/), { target: { value: "rest well" } });
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
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

test("game over: the victory timeline does not repeat the win verb", () => {
  renderWithI18n(
    <GameOverScreen
      events={[
        {
          id: 1 as EventId,
          kind: "game.finished",
          scope: "public",
          createdAt: 1000,
          payload: {
            winningFactions: ["village"],
            winningPlayers: ["wren" as UserId],
            reason: "wolves_eliminated",
          },
        },
      ]}
      snapshot={makeGameSnapshot({
        game: {
          status: "finished",
          winner: {
            winningFactions: ["village"],
            winningPlayers: ["wren" as UserId],
            reason: "wolves_eliminated",
          },
        },
      })}
    />,
  );

  expect(screen.getByText("The game is over — the village wins.")).toBeInTheDocument();
  expect(screen.queryByText(/wins won/i)).not.toBeInTheDocument();
});

test("game over: a replay with chat messages renders no empty timeline rows", () => {
  renderWithI18n(
    <GameOverScreen
      events={[
        {
          id: 1 as EventId,
          kind: "chat.message",
          scope: "public",
          actorUserId: "odile" as UserId,
          createdAt: 1,
          payload: { channel: "public", text: "hello village", mentions: [] },
        },
        {
          id: 2 as EventId,
          kind: "phase.started",
          scope: "public",
          createdAt: 2,
          payload: { phaseId: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        {
          id: 3 as EventId,
          kind: "player.eliminated",
          scope: "public",
          actorUserId: "odile" as UserId,
          createdAt: 3,
          payload: { playerId: "odile" as UserId, role: "werewolf", cause: "day_vote" },
        },
      ]}
      snapshot={makeGameSnapshot({
        game: {
          status: "finished",
          winner: {
            winningFactions: ["village"],
            winningPlayers: ["wren" as UserId],
            reason: "wolves_eliminated",
          },
        },
      })}
    />,
  );

  // The chat message is not a describable timeline row: it must not render an
  // empty <li>, and its text must not appear in the replay list.
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByText("hello village")).not.toBeInTheDocument();
});

test("game over: the replay gutter stamps the day of each phase, not the final day", () => {
  renderWithI18n(
    <GameOverScreen
      events={[
        {
          id: 1 as EventId,
          kind: "phase.started",
          scope: "public",
          createdAt: 1,
          payload: { phaseId: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
        {
          id: 2 as EventId,
          kind: "phase.started",
          scope: "public",
          createdAt: 2,
          payload: { phaseId: 4 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 },
        },
      ]}
      snapshot={makeGameSnapshot({
        game: {
          day: 3,
          status: "finished",
          winner: {
            winningFactions: ["village"],
            winningPlayers: ["wren" as UserId],
            reason: "wolves_eliminated",
          },
        },
      })}
    />,
  );

  expect(screen.getByText("D1")).toBeInTheDocument();
  expect(screen.getByText("D2")).toBeInTheDocument();
  // The final day (3) is not stamped on either row.
  expect(screen.queryByText("D3")).not.toBeInTheDocument();
});

test("game over: dead players carry a skull marker and winners a corner ribbon", () => {
  renderWithI18n(
    <GameOverScreen
      events={[]}
      snapshot={makeGameSnapshot({
        game: {
          status: "finished",
          winner: {
            winningFactions: ["village"],
            winningPlayers: ["wren" as UserId, "odile" as UserId],
            reason: "wolves_eliminated",
          },
        },
        me: { userId: "spectator" as UserId, status: "spectator" },
        players: [
          { userId: "wren" as UserId, displayName: "Wren", status: "alive" },
          {
            userId: "odile" as UserId,
            displayName: "Odile",
            status: "dead",
            revealedRole: "werewolf",
          },
          { userId: "mattias" as UserId, displayName: "Mattias", status: "alive" },
          {
            userId: "kestrel" as UserId,
            displayName: "Kestrel",
            status: "dead",
            revealedRole: "villager",
          },
        ],
      })}
    />,
  );

  const row = (name: string) => within(screen.getByText(name).closest(".row") as HTMLElement);

  // A living non-winner carries neither marker.
  expect(row("Mattias").queryByLabelText("Dead")).not.toBeInTheDocument();
  expect(row("Mattias").queryByLabelText("Winner")).not.toBeInTheDocument();

  // A living winner carries only the ribbon.
  expect(row("Wren").queryByLabelText("Dead")).not.toBeInTheDocument();
  expect(row("Wren").getByLabelText("Winner")).toBeInTheDocument();

  // A dead non-winner carries only the skull.
  expect(row("Kestrel").getByLabelText("Dead")).toBeInTheDocument();
  expect(row("Kestrel").queryByLabelText("Winner")).not.toBeInTheDocument();

  // A dead winner carries both at once.
  expect(row("Odile").getByLabelText("Dead")).toBeInTheDocument();
  expect(row("Odile").getByLabelText("Winner")).toBeInTheDocument();
});

test("talk: the wolves channel lists the other wolves and never the viewer", () => {
  const snapshot = makeGameSnapshot({
    me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
    availableChannels: ["public", "wolves"] as ChatChannel[],
    knownChannelMemberIds: { wolves: ["odile" as UserId, "mattias" as UserId] },
  });
  renderWithI18n(<Talk events={[]} send={vi.fn()} snapshot={snapshot} />);

  fireEvent.click(screen.getByRole("button", { name: "Wolf chat" }));
  const roster = screen.getByRole("group", { name: "In this channel" });
  expect(roster.textContent).toContain("Odile");
  expect(roster.textContent).toContain("Mattias");
  expect(roster.textContent).not.toContain("Wren");
});

test("talk: a converted viewer sees only the channel members they know", () => {
  const snapshot = makeGameSnapshot({
    me: { userId: "wren" as UserId, status: "alive", role: "werewolf" },
    availableChannels: ["public", "wolves"] as ChatChannel[],
    // Converted mid-game: the projection only names the wolves met since.
    knownChannelMemberIds: { wolves: ["odile" as UserId] },
  });
  renderWithI18n(<Talk events={[]} send={vi.fn()} snapshot={snapshot} />);

  fireEvent.click(screen.getByRole("button", { name: "Wolf chat" }));
  const roster = screen.getByRole("group", { name: "In this channel" });
  expect(roster.textContent).toContain("Odile");
  expect(roster.textContent).not.toContain("Mattias");
  expect(roster.textContent).not.toContain("Kestrel");
  expect(roster.textContent).not.toContain("Anna");
});

test("talk: the public and grave channels render no roster row", () => {
  const publicView = renderWithI18n(
    <Talk events={[]} send={vi.fn()} snapshot={makeGameSnapshot()} />,
  );
  expect(screen.queryByRole("group", { name: "In this channel" })).not.toBeInTheDocument();
  publicView.unmount();

  renderWithI18n(
    <Talk
      events={[]}
      send={vi.fn()}
      snapshot={makeGameSnapshot({
        me: { userId: "wren" as UserId, status: "dead", role: "villager" },
        players: [
          {
            userId: "wren" as UserId,
            displayName: "Wren",
            status: "dead",
            revealedRole: "villager",
          },
          {
            userId: "odile" as UserId,
            displayName: "Odile",
            status: "dead",
            revealedRole: "werewolf",
          },
          { userId: "mattias" as UserId, displayName: "Mattias", status: "alive" },
        ],
        availableChannels: ["public", "grave"] as ChatChannel[],
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Grave chat" }));
  expect(screen.queryByRole("group", { name: "In this channel" })).not.toBeInTheDocument();
});

test("the ready control appears for a living player in a running game and is absent for a dead player", () => {
  const alive = renderWithI18n(
    <GameScreen
      initial={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
      })}
      onUpdate={noopUpdate}
    />,
  );
  expect(screen.getByRole("button", { name: "Ready" })).toBeInTheDocument();
  alive.unmount();

  renderWithI18n(
    <GameScreen
      initial={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "dead", role: "villager" },
      })}
      onUpdate={noopUpdate}
    />,
  );
  expect(screen.queryByRole("button", { name: "Ready" })).not.toBeInTheDocument();
});

test("pressing the ready control posts phase.ready, toggling between ready and not ready", () => {
  vi.spyOn(api, "postCommand").mockResolvedValue(undefined);
  const notReady = renderWithI18n(
    <GameScreen
      initial={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
      })}
      onUpdate={noopUpdate}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Ready" }));
  expect(api.postCommand).toHaveBeenCalledWith("g1", {
    type: "phase.ready",
    phaseId: 1,
    payload: { ready: true },
  });
  notReady.unmount();

  // Already ready: pressing again posts ready: false.
  renderWithI18n(
    <GameScreen
      initial={makeGameSnapshot({
        game: { phase: { id: 1 as PhaseId, type: "discussion", startedAt: 1000, endsAt: 10_000 } },
        me: { userId: "wren" as UserId, status: "alive", role: "villager", ready: true },
      })}
      onUpdate={noopUpdate}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Ready" }));
  expect(api.postCommand).toHaveBeenCalledWith("g1", {
    type: "phase.ready",
    phaseId: 1,
    payload: { ready: false },
  });
});

test("the vote screen renders no acted/eligible readout", () => {
  const snapshot = makeGameSnapshot({
    game: { phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 } },
  });
  renderWithI18n(<Act events={[]} send={vi.fn()} snapshot={snapshot} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText(/voted/)).not.toBeInTheDocument();
});
