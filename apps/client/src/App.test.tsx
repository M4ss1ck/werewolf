import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, EventId, GameId, UserId, ViewerGameSnapshot } from "@werewolf/protocol";
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
  expect(StubWebSocket.instances.length).toBeGreaterThan(0);
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
