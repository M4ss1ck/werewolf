import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ChatMessage,
  EventId,
  GameId,
  PhaseId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// jsdom has no layout, so the real virtualizer measures everything at 0px and
// renders nothing — see the same stand-in in screens/global-chat.test.tsx.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: ChatMessage[];
    itemContent: (index: number, message: ChatMessage) => ReactElement;
  }) => (
    <div>
      {data.map((message, index) => (
        <div key={message.id}>{itemContent(index, message)}</div>
      ))}
    </div>
  ),
}));

// The deep-link listener reaches for Tauri APIs that do not exist under jsdom.
vi.mock("./auth/deep-link.ts", () => ({
  listenForAuthDeepLinks: vi.fn(() => () => {}),
}));

const { App } = await import("./App.tsx");

// A stand-in for the browser API: records what was constructed but never
// actually dials out, so rendering Shell in these tests doesn't open real
// jsdom sockets or schedule reconnect timers that outlive the test.
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    StubWebSocket.instances.push(this);
  }

  send() {}
  close() {}
}

beforeEach(() => {
  StubWebSocket.instances = [];
  vi.stubGlobal("WebSocket", StubWebSocket);
});

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

test("a failed sign-in handoff is shown on the sign-in screen, not swallowed", async () => {
  // The handoff can fail for reasons only the server knows (no session, a token
  // it could not mint). Dropping those left the app sitting on the sign-in
  // screen with nothing to show for it, which is unreportable and undebuggable.
  const { listenForAuthDeepLinks } = await import("./auth/deep-link.ts");
  vi.mocked(listenForAuthDeepLinks).mockImplementation((onResult) => {
    onResult({ ok: false, code: "HANDOFF_FAILED" });
    return () => {};
  });

  render(<App />);

  expect(await screen.findByText(/HANDOFF_FAILED/)).toBeInTheDocument();
});

test("a successful sign-in handoff leaves the sign-in screen", async () => {
  const { listenForAuthDeepLinks } = await import("./auth/deep-link.ts");
  let onResult: Parameters<typeof listenForAuthDeepLinks>[0] | undefined;
  vi.mocked(listenForAuthDeepLinks).mockImplementation((callback) => {
    onResult = callback;
    return () => {};
  });
  let signedIn = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) =>
      Promise.resolve(
        new Response(
          String(input) === "/api/auth/get-session"
            ? JSON.stringify(signedIn ? { user: { id: "me", username: "wren" } } : null)
            : JSON.stringify([]),
          { status: 200 },
        ),
      ),
    ),
  );
  render(<App />);
  await screen.findByRole("button", { name: /Sign in/ });
  await waitFor(() => expect(onResult).toBeDefined());

  signedIn = true;
  act(() => onResult?.({ ok: true }));

  expect(await screen.findByRole("heading", { name: "Open games" })).toBeInTheDocument();
});

test("does not open the chat socket for a signed-out visitor", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    ),
  );
  render(<App />);

  await screen.findByRole("button", { name: /Sign in/ });
  expect(StubWebSocket.instances).toHaveLength(0);
});

test("does not open the chat socket for a signed-in visitor without a username", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) =>
      Promise.resolve(
        new Response(
          String(input) === "/api/auth/get-session"
            ? JSON.stringify({ user: { id: "me", username: null } })
            : JSON.stringify([]),
          { status: 200 },
        ),
      ),
    ),
  );
  render(<App />);

  await screen.findByLabelText("Username");
  expect(StubWebSocket.instances).toHaveLength(0);
});

test("opens the chat socket once signed in with a username", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) =>
      Promise.resolve(
        new Response(
          String(input) === "/api/auth/get-session"
            ? JSON.stringify({ user: { id: "me", username: "wren" } })
            : JSON.stringify([]),
          { status: 200 },
        ),
      ),
    ),
  );
  render(<App />);

  await screen.findByRole("heading", { name: "Open games" });
  // The socket opens in an effect, which is not guaranteed to have run by the
  // time the heading renders, so settle rather than assume the ordering.
  await waitFor(() => expect(StubWebSocket.instances.length).toBeGreaterThan(0));
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

test("a game that finishes while it is open swaps to the game-over screen", async () => {
  window.history.replaceState({}, "", "/games/g1");
  const running: ViewerGameSnapshot = {
    game: {
      id: "g1" as GameId,
      name: "Game One",
      ownerUserId: "owner" as UserId,
      status: "running",
      day: 2,
      phase: { id: 7 as PhaseId, type: "voting", startedAt: 1000, endsAt: 10_000 },
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
  const finished: ViewerGameSnapshot = {
    game: {
      id: "g1" as GameId,
      name: "Game One",
      ownerUserId: "owner" as UserId,
      status: "finished",
      day: 3,
      phase: null,
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 120, voting: 60, night: 60 },
      },
      winner: {
        winningFactions: ["village"],
        winningPlayers: ["wren" as UserId],
        reason: "wolves_eliminated",
      },
    },
    players: [
      { userId: "wren" as UserId, displayName: "Wren", status: "alive" },
      { userId: "odile" as UserId, displayName: "Odile", status: "dead", revealedRole: "werewolf" },
      { userId: "mattias" as UserId, displayName: "Mattias", status: "alive" },
      { userId: "kestrel" as UserId, displayName: "Kestrel", status: "alive" },
      { userId: "anna" as UserId, displayName: "Anna", status: "alive" },
    ],
    me: { userId: "wren" as UserId, status: "alive", role: "villager" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 1 as EventId,
    serverNow: 6000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), { status: 200 }),
        );
      if (url === "/api/games/g1")
        return Promise.resolve(new Response(JSON.stringify(running), { status: 200 }));
      // GameOverScreen fetches the replay for its timeline when no events prop
      // is given; the empty list keeps this test out of event rendering.
      if (url === "/api/games/g1/replay")
        return Promise.resolve(
          new Response(JSON.stringify({ snapshot: finished, events: [] }), { status: 200 }),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  render(<App />);

  await screen.findByRole("button", { name: "Village" });

  const live = StubWebSocket.instances.find((socket) => socket.url.endsWith("/api/games/g1/live"));
  expect(live).toBeDefined();
  // The sync frame carries the finished snapshot; the socket's handler lifts
  // it to the shell, which swaps the in-game screen for the game-over one.
  await act(async () => {
    live!.onopen?.();
    live!.onmessage?.({
      data: JSON.stringify({ type: "sync", snapshot: finished, events: [], cursor: 0 }),
    } as MessageEvent);
  });

  expect(await screen.findByRole("heading", { name: "The pack is broken" })).toBeInTheDocument();
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

test("a sent chat message appears even with a dead socket", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), { status: 200 }),
        );
      if (url === "/api/chat/messages" && init?.method === "POST")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              userId: "me",
              displayName: "wren",
              text: "hello",
              createdAt: 1_000_000,
            }),
            { status: 201 },
          ),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const input = await screen.findByLabelText("Message");
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.click(screen.getByLabelText("Send message"));

  // The dead socket (StubWebSocket) never delivers an echo; the message must
  // still appear because the POST response is folded into chat state.
  expect(await screen.findByText("hello")).toBeInTheDocument();
});

test("clears the chat send error when the route changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), { status: 200 }),
        );
      if (url === "/api/chat/messages" && init?.method === "POST")
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429 }),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const input = await screen.findByLabelText("Message");
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.click(screen.getByLabelText("Send message"));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("too quickly"));

  fireEvent.click(screen.getByRole("button", { name: "Games" }));
  await screen.findByRole("heading", { name: "Open games" });

  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("heading", { name: "Global chat" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
