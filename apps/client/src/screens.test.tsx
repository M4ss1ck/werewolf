import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  ChatChannel,
  EventId,
  GameId,
  GamePhase,
  GamePlayerStatus,
  GameStatus,
  RoleId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ApiError } from "./api/client.ts";
import { ErrorMessage } from "./components.tsx";
import { i18n } from "./i18n/i18n.ts";
import { GameScreen, GamesScreen, LobbyScreen, SignInScreen } from "./screens.tsx";

/** Minimal WebSocket stand-in: GameScreen opens a live connection on mount and
 * jsdom has no WebSocket implementation, so the stub just swallows it. */
class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(_data: string) {}
  close() {
    this.readyState = 3;
  }
}

interface PlayerInput {
  userId: string;
  displayName: string;
  status: GamePlayerStatus;
  revealedRole?: RoleId;
}
interface MeInput {
  userId: string;
  status?: GamePlayerStatus;
  role?: RoleId;
}
interface SnapshotOverrides {
  status?: GameStatus;
  phaseType?: GamePhase | null;
  players?: PlayerInput[];
  me?: MeInput;
  availableActions?: ViewerGameSnapshot["availableActions"];
  channels?: ChatChannel[];
  progress?: { acted: number; eligible: number };
  ownerUserId?: string;
}

function makeSnapshot(overrides: SnapshotOverrides = {}): ViewerGameSnapshot {
  const players: ViewerGameSnapshot["players"] = (overrides.players ?? []).map((player) => ({
    userId: player.userId as UserId,
    displayName: player.displayName,
    status: player.status,
    ...(player.revealedRole ? { revealedRole: player.revealedRole } : {}),
  }));
  const me: ViewerGameSnapshot["me"] = overrides.me
    ? {
        userId: overrides.me.userId as UserId,
        status: overrides.me.status ?? "alive",
        ...(overrides.me.role ? { role: overrides.me.role } : {}),
      }
    : undefined;
  return {
    game: {
      id: "game-1" as GameId,
      name: "Test Game",
      ownerUserId: (overrides.ownerUserId ?? "owner") as UserId,
      status: overrides.status ?? "running",
      day: 1,
      phase: overrides.phaseType
        ? { id: 1 as never, type: overrides.phaseType, startedAt: 1000, endsAt: 3000 }
        : null,
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 60, voting: 60, night: 60 },
      },
    },
    players,
    ...(me ? { me } : {}),
    availableActions: overrides.availableActions ?? [],
    availableChannels: overrides.channels ?? ["public"],
    progress: overrides.progress ?? { acted: 0, eligible: 0 },
    cursor: 0 as EventId,
    serverNow: 1000,
  };
}

const PLAYERS = [
  { userId: "me", displayName: "Me", status: "alive" as const },
  { userId: "bob", displayName: "Bob", status: "alive" as const },
];

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("the games list renders games and a create form", async () => {
  const games = [
    { id: "g1", name: "Game One", status: "lobby", playerCount: 3 },
    { id: "g2", name: "Game Two", status: "running", playerCount: 5 },
  ];
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(games), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  renderWithI18n(<GamesScreen onOpen={() => undefined} />);

  expect(await screen.findByText("Game One")).toBeInTheDocument();
  expect(screen.getByText("Game Two")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Create game" })).toBeInTheDocument();
  expect(screen.getByLabelText("Game name")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Create game" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Spectate" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/games", expect.anything());
});

test("the create form labels every control visibly and accessibly", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
  renderWithI18n(<GamesScreen onOpen={() => undefined} />);

  // Every control is associated with a label whose text is visible on screen,
  // not a placeholder masquerading as a label.
  expect(screen.getByLabelText("Game name")).toBeInTheDocument();
  expect(screen.getByText("Game name")).toBeVisible();
  expect(screen.getByLabelText("Visibility")).toBeInTheDocument();
  expect(screen.getByText("Visibility")).toBeVisible();
  expect(screen.getByLabelText("Allow spectating")).toBeInTheDocument();
  // The scheduled-start control is a radio preset picker, "manual" by default.
  expect(screen.getByRole("radio", { name: "Start manually" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "In 5 minutes" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Pick a time" }));
  expect(
    screen.getByLabelText("Pick a time", { selector: "input[type='datetime-local']" }),
  ).toBeInTheDocument();
  // Phase durations carry unit context next to each labelled field.
  expect(screen.getByLabelText("Discussion")).toBeInTheDocument();
  expect(screen.getByLabelText("Voting")).toBeInTheDocument();
  expect(screen.getByLabelText("Night")).toBeInTheDocument();
  // Presentation values are translated, not the wire values.
  expect(screen.getByRole("option", { name: "Public" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Private" })).toBeInTheDocument();
});

test("lobby owner controls appear for exactly the owner", () => {
  const players = [
    { userId: "owner", displayName: "Owner", status: "lobby" as const },
    { userId: "bob", displayName: "Bob", status: "lobby" as const },
  ];
  const base = { status: "lobby" as GameStatus, phaseType: null, players, ownerUserId: "owner" };

  // A non-owner sees no start, cancel or kick controls, only leave.
  const nonOwner = renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeSnapshot({ ...base, me: { userId: "bob", status: "lobby" } })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Cancel ·/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
  nonOwner.unmount();

  // The owner sees start, cancel and a kick control per other player, no leave.
  renderWithI18n(
    <LobbyScreen
      onUpdate={() => undefined}
      snapshot={makeSnapshot({ ...base, me: { userId: "owner", status: "lobby" } })}
    />,
  );
  expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel · Bob" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Leave" })).not.toBeInTheDocument();
});

test("action controls render from availableActions; none offered renders none even for a seer", () => {
  // The viewer's own role is seer, but the server offered no actions: nothing renders.
  const noActions = renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "night",
        me: { userId: "me", role: "seer" },
        players: PLAYERS,
      })}
    />,
  );
  expect(screen.queryByText("Inspect")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Bob" })).not.toBeInTheDocument();
  noActions.unmount();

  // The same viewer with an offered action gets exactly that control.
  renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "night",
        me: { userId: "me", role: "seer" },
        players: PLAYERS,
        availableActions: [
          {
            id: "seer.inspect",
            type: "target",
            targets: [{ userId: "bob" as UserId, enabled: true }],
          },
        ],
      })}
    />,
  );
  expect(screen.getByText("Inspect")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Bob" })).toBeInTheDocument();
});

test("a target marked disabled renders disabled rather than missing", () => {
  renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "night",
        me: { userId: "me", role: "werewolf" },
        players: PLAYERS,
        availableActions: [
          {
            id: "wolf.attack",
            type: "target",
            targets: [
              { userId: "bob" as UserId, enabled: false },
              { userId: "me" as UserId, enabled: true },
            ],
          },
        ],
      })}
    />,
  );
  const blocked = screen.getByRole("button", { name: "Bob" });
  expect(blocked).toBeInTheDocument();
  expect(blocked).toBeDisabled();
  expect(screen.getByRole("button", { name: "Me" })).toBeEnabled();
});

test("voting shows progress as a count and never per-target tallies", () => {
  const players = [
    { userId: "me", displayName: "Me", status: "alive" as const },
    { userId: "u2", displayName: "Alice", status: "alive" as const },
    { userId: "u3", displayName: "Bob", status: "alive" as const },
    { userId: "u4", displayName: "Carol", status: "alive" as const },
    { userId: "u5", displayName: "Dan", status: "alive" as const },
  ];
  renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "voting",
        me: { userId: "me", status: "alive" },
        players,
        progress: { acted: 3, eligible: 5 },
      })}
    />,
  );

  // The count is how many voted out of how many are eligible.
  expect(screen.getByText("3 / 5")).toBeInTheDocument();
  // Peers render as vote targets, plus an abstain button.
  expect(screen.getByRole("button", { name: "Alice" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Abstain" })).toBeInTheDocument();
  // No per-target tally may appear anywhere in the output.
  expect(document.body.textContent).not.toMatch(/\d+\s+(votes?|votos?)/i);
});

test("the wolf chat tab appears only when the snapshot lists that channel", () => {
  const withWolfChat = renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "discussion",
        me: { userId: "me", role: "werewolf" },
        players: PLAYERS,
        channels: ["public", "wolves"],
      })}
    />,
  );
  expect(screen.getByRole("button", { name: "Wolf chat" })).toBeInTheDocument();
  withWolfChat.unmount();

  renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "discussion",
        me: { userId: "me" },
        players: PLAYERS,
        channels: ["public"],
      })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Wolf chat" })).not.toBeInTheDocument();
});

test("a read-only channel renders its composer disabled", () => {
  renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "discussion",
        me: { userId: "me", status: "dead" },
        players: [
          { userId: "me", displayName: "Me", status: "dead" },
          { userId: "bob", displayName: "Bob", status: "alive" },
        ],
      })}
    />,
  );
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("a dead player's revealed role shows in the list; living players show none", () => {
  renderWithI18n(
    <GameScreen
      initial={makeSnapshot({
        phaseType: "discussion",
        me: { userId: "me", role: "seer" },
        players: [
          { userId: "me", displayName: "Me", status: "alive" },
          { userId: "bob", displayName: "Bob", status: "dead", revealedRole: "werewolf" },
        ],
      })}
    />,
  );

  const deadRow = screen.getByText("Bob").closest("li");
  expect(deadRow).not.toBeNull();
  expect(within(deadRow as HTMLElement).getByText(/Werewolf/)).toBeInTheDocument();

  const livingRow = screen.getByText("Me").closest("li");
  expect(livingRow).not.toBeNull();
  expect(
    within(livingRow as HTMLElement).queryByText(
      /Villager|Werewolf|Mason|Seer|Cursed|Harlot|Hunter|Princess/,
    ),
  ).not.toBeInTheDocument();
});

test("an error code renders its translated message, not the code", () => {
  renderWithI18n(<ErrorMessage error={new ApiError("PHASE_CLOSED")} />);
  expect(screen.getByText("That phase has already ended.")).toBeInTheDocument();
  expect(screen.queryByText("PHASE_CLOSED")).not.toBeInTheDocument();
});

test("switching language changes visible copy", async () => {
  renderWithI18n(<SignInScreen onRefresh={() => undefined} session={null} />);
  expect(screen.getByRole("button", { name: /Sign in/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "ES" }));

  expect(await screen.findByRole("button", { name: /Iniciar sesión/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Sign in/ })).not.toBeInTheDocument();

  // Leave the shared i18n singleton in English for anything that runs after.
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});
