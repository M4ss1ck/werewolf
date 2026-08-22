import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ChatMessage,
  EventId,
  GameId,
  PhaseId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { forwardRef, type ReactElement, useEffect, useImperativeHandle, useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const virtuosoControl = vi.hoisted(() => ({
  scrolls: [] as { location: unknown; rowPresent: boolean }[],
}));

// jsdom has no layout, so the real virtualizer measures everything at 0px and
// renders nothing — see the same stand-in in screens/global-chat.test.tsx.
vi.mock("react-virtuoso", () => {
  type MockVirtuosoHandle = {
    getState(callback: (state: { ranges: []; scrollTop: number }) => void): void;
    scrollToIndex(location: unknown): void;
  };
  type MockVirtuosoProps = {
    atBottomStateChange?: (atBottom: boolean) => void;
    data: ChatMessage[];
    firstItemIndex?: number;
    historyTruncated?: boolean;
    itemContent: (index: number, message: ChatMessage) => ReactElement;
    restoreStateFrom?: { ranges: []; scrollTop: number };
    scrollerRef?: (element: HTMLElement | Window | null) => void;
    startReached?: () => void;
  };
  const Virtuoso = forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(function MockVirtuoso(
    {
      atBottomStateChange,
      data,
      firstItemIndex,
      historyTruncated,
      itemContent,
      restoreStateFrom,
      scrollerRef,
      startReached,
    }: MockVirtuosoProps,
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => ({
      getState: (callback) => callback({ ranges: [], scrollTop: 12 }),
      scrollToIndex: (location) =>
        virtuosoControl.scrolls.push({
          location,
          rowPresent: document.querySelector("[data-message-id]") !== null,
        }),
    }));
    useEffect(() => {
      scrollerRef?.(rootRef.current);
    }, [scrollerRef]);
    return (
      <div
        data-restore-state={
          restoreStateFrom === undefined ? "absent" : JSON.stringify(restoreStateFrom)
        }
        data-first-index={firstItemIndex}
        data-message-count={data.length}
        data-truncated={String(historyTruncated ?? false)}
        data-testid="virtualizer-root"
        ref={rootRef}
      >
        {data.map((message, index) => (
          <div key={message.id}>{itemContent(index, message)}</div>
        ))}
        {startReached !== undefined && (
          <button data-testid="virtualizer-start-reached" onClick={startReached} type="button">
            virtualizer-start-reached
          </button>
        )}
        {atBottomStateChange !== undefined && (
          <button
            data-testid="virtualizer-force-not-at-bottom"
            onClick={() => atBottomStateChange(false)}
            type="button"
          >
            virtualizer-force-not-at-bottom
          </button>
        )}
      </div>
    );
  });
  return { Virtuoso };
});

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
  sent: string[] = [];
  close = vi.fn();

  constructor(public readonly url: string) {
    StubWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
  receive(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

type StubObserverEntry = {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
  boundingClientRect: DOMRect;
};

class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];
  private readonly observed = new Set<Element>();

  constructor(private readonly callback: (entries: StubObserverEntry[]) => void) {
    StubIntersectionObserver.instances.push(this);
  }

  disconnect() {
    this.observed.clear();
  }

  observe(element: Element) {
    this.observed.add(element);
  }

  unobserve(element: Element) {
    this.observed.delete(element);
  }

  trigger(element: Element) {
    if (!this.observed.has(element)) return;
    this.callback([
      {
        target: element,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: { top: 0, bottom: 40 } as DOMRect,
      },
    ]);
  }
}

beforeEach(() => {
  StubWebSocket.instances = [];
  StubIntersectionObserver.instances = [];
  virtuosoControl.scrolls = [];
  window.localStorage.clear();
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.stubGlobal("WebSocket", StubWebSocket);
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
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

test("baselines the merged first history, so a push racing history is not falsely unread", async () => {
  const message = (id: number, text: string): ChatMessage => ({
    id: id as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text,
    mentions: [],
    createdAt: id,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.find((candidate) =>
      candidate.url.endsWith("/api/chat/live"),
    );
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.onopen?.();
    socket.receive(JSON.stringify({ type: "message", message: message(2, "racing push") }));
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [message(1, "history")],
        cursor: 2,
        oldestRetainedId: 1,
        hasOlder: false,
        historyTruncated: false,
      }),
    );
  });

  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Chat, \d/ })).not.toBeInTheDocument(),
  );
});

test("passes the stored global frontier on the first subscribe, including an explicit zero", async () => {
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 0, seenAfter: [], touchedAt: 1 }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  await waitFor(() => expect(StubWebSocket.instances.at(-1)).toBeDefined());
  const socket = StubWebSocket.instances.at(-1)!;
  socket.onopen?.();
  expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "subscribe", readCursor: 0 });
});

test("does not baseline history over a saved global frontier", async () => {
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 0, seenAfter: [], touchedAt: 1 }),
  );
  const row = (id: number): ChatMessage => ({
    id: id as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: `message ${id}`,
    mentions: [],
    createdAt: id,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row(1)],
        cursor: 1,
        oldestRetainedId: 1,
        hasOlder: false,
        historyTruncated: false,
      }),
    );
    socket.receive(JSON.stringify({ type: "message", message: row(2) }));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Chat, 2" })).toBeInTheDocument());
});

test("omits readCursor from the first subscribe when no frontier is stored", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  socket.onopen?.();
  expect(JSON.parse(socket.sent[0]!)).not.toHaveProperty("readCursor");
});

test("rebases a persisted frontier beyond a reset retention latest before later pushes", async () => {
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 99, seenAfter: [], touchedAt: 1 }),
  );
  const chatMessage = (id: number): ChatMessage => ({
    id: id as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: `message ${id}`,
    mentions: [],
    createdAt: id,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [chatMessage(5)],
        cursor: 5,
        oldestRetainedId: 5,
        hasOlder: false,
        historyTruncated: true,
      }),
    );
    socket.receive(JSON.stringify({ type: "message", message: chatMessage(6) }));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Chat, 1" })).toBeInTheDocument());
  const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
  expect(stored.readThrough).toBe(5);
});

test("keeps a reset frontier in memory across a second history frame", async () => {
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 99, seenAfter: [], touchedAt: 1 }),
  );
  const row = (id: number): ChatMessage => ({
    id: id as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: `message ${id}`,
    mentions: [],
    createdAt: id,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  await waitFor(() => expect(StubWebSocket.instances.at(-1)).toBeDefined());
  const socket = StubWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row(5)],
        cursor: 5,
        oldestRetainedId: 5,
        hasOlder: false,
        historyTruncated: true,
      }),
    );
    socket.receive(JSON.stringify({ type: "message", message: row(6) }));
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row(5), row(6)],
        cursor: 6,
        oldestRetainedId: 5,
        hasOlder: false,
        historyTruncated: true,
      }),
    );
    socket.receive(JSON.stringify({ type: "message", message: row(7) }));
  });

  await waitFor(() => expect(screen.getByRole("button", { name: "Chat, 2" })).toBeInTheDocument());
  const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
  expect(stored.readThrough).toBe(5);
});

test("keeps a reset frontier authoritative through visibility and mark-through", async () => {
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 99, seenAfter: [], touchedAt: 1 }),
  );
  const row = (id: number): ChatMessage => ({
    id: id as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: `message ${id}`,
    mentions: [],
    createdAt: id,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  await waitFor(() => expect(StubWebSocket.instances.at(-1)).toBeDefined());
  const socket = StubWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row(5)],
        cursor: 5,
        oldestRetainedId: 5,
        hasOlder: false,
        historyTruncated: true,
      }),
    );
    socket.receive(JSON.stringify({ type: "message", message: row(6) }));
  });

  fireEvent.click(await screen.findByRole("button", { name: "Chat, 1" }));
  await screen.findByRole("heading", { name: "Global chat" });
  await act(
    async () =>
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
      ),
  );

  const visibleRow = document.querySelector<HTMLElement>('[data-message-id="6"]');
  expect(visibleRow).not.toBeNull();
  act(() => StubIntersectionObserver.instances.at(-1)?.trigger(visibleRow!));
  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
    expect(stored.readThrough).toBe(6);
  });

  fireEvent.click(screen.getByTestId("virtualizer-force-not-at-bottom"));
  fireEvent.click(await screen.findByRole("button", { name: /Jump to latest/ }));
  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
    expect(stored.readThrough).toBe(6);
  });

  // A second tab may advance the persisted frontier after the retention reset.
  // The next ordinary mark must adopt that frontier instead of writing the
  // reset value back over it.
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 120, seenAfter: [], touchedAt: 2 }),
  );
  fireEvent.click(await screen.findByRole("button", { name: /Jump to latest/ }));
  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
    expect(stored.readThrough).toBe(120);
  });
});

test("opening global chat does not mark pushed rows read", async () => {
  const row = (id: number): ChatMessage => ({
    id: id as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: `message ${id}`,
    mentions: [],
    createdAt: id,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row(1)],
        cursor: 1,
        oldestRetainedId: 1,
        hasOlder: false,
        historyTruncated: false,
      }),
    );
    socket.receive(JSON.stringify({ type: "message", message: row(2) }));
  });
  fireEvent.click(screen.getByRole("button", { name: /Chat, 1/ }));
  await screen.findByRole("heading", { name: "Global chat" });
  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
    expect(stored.readThrough).toBe(1);
  });
});

test("keeps one global socket across main and game routes and closes it on unmount", async () => {
  window.history.replaceState({}, "", "/");
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
    players: [{ userId: "me" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "me" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
      Promise.resolve(
        new Response(
          String(input) === "/api/auth/get-session"
            ? JSON.stringify({ user: { id: "me", username: "wren" } })
            : String(input) === "/api/games/g1"
              ? JSON.stringify(snapshot)
              : JSON.stringify([]),
          { status: 200 },
        ),
      ),
    ),
  );

  const view = render(<App />);
  await screen.findByRole("heading", { name: "Open games" });
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    window.history.pushState({}, "", "/games/g1");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("heading", { name: "Game One" });
  await act(async () => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("heading", { name: "Open games" });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  fireEvent.click(screen.getByRole("button", { name: "Games" }));
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(
    StubWebSocket.instances.filter((candidate) => candidate.url.endsWith("/api/chat/live")),
  ).toHaveLength(1);
  view.unmount();
  expect(socket.close).toHaveBeenCalledOnce();
});

test("keeps the global count on every main route but out of game and replay UI", async () => {
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
    players: [{ userId: "me" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "me" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  const pushedMessage: ChatMessage = {
    id: 1 as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: "@Wren, hello",
    mentions: [{ userId: "me" as UserId, start: 0, length: 5 }],
    createdAt: 1,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url === "/api/games/g1")
        return Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 }));
      if (url === "/api/games/g1/replay")
        return Promise.resolve(
          new Response(JSON.stringify({ snapshot, events: [] }), { status: 200 }),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );

  render(<App />);
  await screen.findByRole("heading", { name: "Open games" });
  const global = await vi.waitFor(() => {
    const socket = StubWebSocket.instances.find((candidate) =>
      candidate.url.endsWith("/api/chat/live"),
    );
    expect(socket).toBeDefined();
    return socket!;
  });
  await act(async () => {
    global.receive(JSON.stringify({ type: "message", message: pushedMessage }));
  });

  const go = async (path: string) => {
    await act(async () => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  };

  expect(screen.getByRole("button", { name: /Chat, 1/ })).toBeInTheDocument();
  await go("/create");
  expect(screen.getByRole("button", { name: /Chat, 1/ })).toBeInTheDocument();
  await go("/profile");
  expect(screen.getByRole("button", { name: /Chat, 1/ })).toBeInTheDocument();
  await go("/games/g1");
  expect(await screen.findByRole("button", { name: "Back to games" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Chat/ })).not.toBeInTheDocument();
  await go("/games/g1/replay");
  expect(await screen.findByRole("button", { name: "Back to games" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Chat/ })).not.toBeInTheDocument();
  await go("/");
  expect(await screen.findByRole("button", { name: /Chat, 1/ })).toBeInTheDocument();
});

test("restores the global viewport after leaving and returning to Chat", async () => {
  const row: ChatMessage = {
    id: 1 as ChatMessage["id"],
    userId: "me" as UserId,
    displayName: "Other",
    text: "held row",
    mentions: [],
    createdAt: 1,
  };
  window.localStorage.setItem(
    "werewolf.chat-read.v1:me:global",
    JSON.stringify({ version: 1, readThrough: 1, seenAfter: [], touchedAt: 1 }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row],
        cursor: 1,
        oldestRetainedId: 1,
        hasOlder: false,
        historyTruncated: false,
      }),
    );
  });

  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("heading", { name: "Global chat" });
  expect(screen.getByTestId("virtualizer-root")).toHaveAttribute("data-restore-state", "absent");
  await act(
    async () =>
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Games" }));
  await screen.findByRole("heading", { name: "Open games" });
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("heading", { name: "Global chat" });
  expect(screen.getByTestId("virtualizer-root")).toHaveAttribute(
    "data-restore-state",
    JSON.stringify({ ranges: [], scrollTop: 12 }),
  );
});

test("keeps a global draft across routes but destroys it when the account key changes", async () => {
  const { listenForAuthDeepLinks } = await import("./auth/deep-link.ts");
  let onResult: Parameters<typeof listenForAuthDeepLinks>[0] | undefined;
  vi.mocked(listenForAuthDeepLinks).mockImplementation((callback) => {
    onResult = callback;
    return () => {};
  });
  let account = { id: "me", username: "wren" };
  const gameSnapshot: ViewerGameSnapshot = {
    game: {
      id: "g1" as GameId,
      name: "Continuity Game",
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
    players: [{ userId: "me" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "me" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(new Response(JSON.stringify({ user: account }), { status: 200 }));
      if (url === "/api/games/g1")
        return Promise.resolve(new Response(JSON.stringify(gameSnapshot), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );

  render(<App />);
  await screen.findByRole("heading", { name: "Open games" });
  const oldSocket = await vi.waitFor(() => {
    const socket = StubWebSocket.instances.find((candidate) =>
      candidate.url.endsWith("/api/chat/live"),
    );
    expect(socket).toBeDefined();
    return socket!;
  });
  await act(async () => {
    window.history.pushState({}, "", "/chat");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const input = await screen.findByLabelText("Message");
  fireEvent.change(input, { target: { value: "draft survives tabs" } });
  await act(async () => {
    window.history.pushState({}, "", "/create");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => {
    window.history.pushState({}, "", "/chat");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByLabelText("Message")).toHaveValue("draft survives tabs");
  await act(async () => {
    window.history.pushState({}, "", "/games/g1");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("button", { name: "Back to games" });
  await act(async () => {
    window.history.pushState({}, "", "/chat");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByLabelText("Message")).toHaveValue("draft survives tabs");

  account = { id: "another-user", username: "raven" };
  await act(async () => onResult?.({ ok: true }));
  expect(await screen.findByLabelText("Message")).toHaveValue("");
  expect(oldSocket.close).toHaveBeenCalledOnce();
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

  // The socket is opened in an effect, which does not necessarily flush in the
  // same turn as the render that findByRole above waited on. Reading instances
  // synchronously made this test fail intermittently under load.
  const live = await vi.waitFor(() => {
    const socket = StubWebSocket.instances.find((candidate) =>
      candidate.url.endsWith("/api/games/g1/live"),
    );
    expect(socket).toBeDefined();
    return socket!;
  });
  const global = StubWebSocket.instances.find((candidate) =>
    candidate.url.endsWith("/api/chat/live"),
  );
  expect(global).toBeDefined();
  // The sync frame carries the finished snapshot; the socket's handler lifts
  // it to the shell, which swaps the in-game screen for the game-over one.
  await act(async () => {
    live.onopen?.();
    live.onmessage?.({
      data: JSON.stringify({ type: "sync", snapshot: finished, events: [], cursor: 0 }),
    } as MessageEvent);
  });

  expect(await screen.findByRole("heading", { name: "The pack is broken" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Village" })).not.toBeInTheDocument();
  expect(global!.close).not.toHaveBeenCalled();
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

  // Assert the navigation before the render. The click pushes the path and
  // fires popstate synchronously, so a failure here means the click never
  // landed, while a failure below means it landed and the route did not
  // re-render. CI has failed on the render half once, and the two look
  // identical from a DOM dump.
  expect(window.location.pathname).toBe("/");
  await screen.findByRole("heading", { name: "Open games" });
});

test("a navigation that beats the popstate listener is still picked up", async () => {
  // The route is read from the URL when the shell mounts and re-read only on
  // popstate. Between those two moments nothing is listening, so a navigation
  // there is lost and the URL and the screen disagree for the rest of the
  // session — pathname "/" with the game route still on screen, which is what
  // CI reported. Move the URL as the listener registers to land in that window.
  window.history.replaceState({}, "", "/games/g1");
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  let moved = false;
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "popstate" && !moved) {
      moved = true;
      window.history.pushState({}, "", "/");
    }
    addEventListener(type, listener, options);
  });

  render(<App />);

  await screen.findByRole("heading", { name: "Open games" });
  expect(window.location.pathname).toBe("/");
});

test("a game route loads its snapshot once", async () => {
  // The route is re-read when the popstate listener attaches. If that re-read
  // produces a fresh Route object the snapshot effect keys on, it re-runs and
  // fires a second GET for the same game — a duplicate request on every load.
  window.history.replaceState({}, "", "/games/a");
  const loaded: ViewerGameSnapshot = {
    game: {
      id: "a" as GameId,
      name: "Game A",
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
    players: [{ userId: "me" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "me" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  };
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
    const url = String(input);
    if (url === "/api/auth/get-session")
      return Promise.resolve(
        new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), { status: 200 }),
      );
    if (url === "/api/games/a")
      return Promise.resolve(new Response(JSON.stringify(loaded), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  await screen.findByRole("heading", { name: "Game A" });

  expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/games/a")).toHaveLength(1);
});

test("associates game snapshots with the requested route and clears failed loads", async () => {
  const snapshot = (id: string, name: string): ViewerGameSnapshot => ({
    game: {
      id: id as GameId,
      name,
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
    players: [{ userId: "me" as UserId, displayName: "Wren", status: "lobby" }],
    me: { userId: "me" as UserId, status: "lobby" },
    availableActions: [],
    availableChannels: ["public"],
    cursor: 0 as EventId,
    serverNow: 5000,
  });
  let resolveA: ((response: Response) => void) | undefined;
  let resolveB: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url === "/api/games/a")
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      if (url === "/api/games/b")
        return new Promise<Response>((resolve) => {
          resolveB = resolve;
        });
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/games/a");
  render(<App />);
  await screen.findByRole("button", { name: "Back to games" });
  await waitFor(() => expect(resolveA).toBeDefined());
  await act(async () => {
    resolveA?.(new Response(JSON.stringify(snapshot("a", "Game A")), { status: 200 }));
  });
  await screen.findByRole("heading", { name: "Game A" });

  await act(async () => {
    window.history.pushState({}, "", "/games/b");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByRole("heading", { name: "Game A" })).not.toBeInTheDocument();
  await waitFor(() => expect(resolveB).toBeDefined());

  await act(async () => {
    resolveB?.(
      new Response(JSON.stringify({ error: { code: "GAME_NOT_FOUND" } }), { status: 404 }),
    );
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("GAME_NOT_FOUND");
  expect(screen.queryByRole("heading", { name: "Game A" })).not.toBeInTheDocument();
});

test("a sent chat message appears even with a dead socket", async () => {
  let sentContent: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), { status: 200 }),
        );
      if (url === "/api/chat/messages" && init?.method === "POST") {
        sentContent = JSON.parse(String(init.body));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              userId: "me",
              displayName: "wren",
              text: "hello",
              mentions: [],
              createdAt: 1_000_000,
            }),
            { status: 201 },
          ),
        );
      }
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
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
  expect(sentContent).toEqual({ text: "hello", mentions: [] });
  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
    expect(stored.readThrough).toBe(1);
  });
  await waitFor(() => expect(virtuosoControl.scrolls.length).toBeGreaterThan(0));
  expect(virtuosoControl.scrolls.at(-1)?.location).toMatchObject({ align: "end" });
  expect(virtuosoControl.scrolls.at(-1)?.rowPresent).toBe(true);
});

test("merges an HTTP response that arrives behind a pushed message", async () => {
  const pushed: ChatMessage = {
    id: 20 as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: "pushed twenty",
    mentions: [],
    createdAt: 20,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url === "/api/chat/messages" && init?.method === "POST")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 19,
              userId: "me",
              displayName: "wren",
              text: "http nineteen",
              mentions: [],
              createdAt: 19,
            }),
            { status: 201 },
          ),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(JSON.stringify({ type: "message", message: pushed }));
  });
  const input = await screen.findByLabelText("Message");
  await act(async () => {
    fireEvent.change(input, { target: { value: "send this" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  await act(async () => {
    expect(await screen.findByText("http nineteen")).toBeInTheDocument();
  });
  expect(screen.getByText("pushed twenty")).toBeInTheDocument();
  const rows = [...document.querySelectorAll("[data-message-id]")].map((row) => row.textContent);
  expect(rows.findIndex((text) => text?.includes("http nineteen"))).toBeLessThan(
    rows.findIndex((text) => text?.includes("pushed twenty")),
  );
  await waitFor(() => {
    const stored = JSON.parse(window.localStorage.getItem("werewolf.chat-read.v1:me:global")!);
    expect(stored.readThrough).toBe(19);
  });
});

test("advances the chat cursor when a successful POST is newer than delivery", async () => {
  const pushed: ChatMessage = {
    id: 20 as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: "pushed twenty",
    mentions: [],
    createdAt: 20,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url === "/api/chat/messages" && init?.method === "POST")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 21,
              userId: "me",
              displayName: "wren",
              text: "http twenty-one",
              mentions: [],
              createdAt: 21,
            }),
            { status: 201 },
          ),
        );
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(JSON.stringify({ type: "message", message: pushed }));
  });
  const input = await screen.findByLabelText("Message");
  await act(async () => {
    fireEvent.change(input, { target: { value: "send newer" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    expect(await screen.findByText("http twenty-one")).toBeInTheDocument();
  });

  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "message",
        message: { ...pushed, id: 21, text: "echo twenty-one", userId: "me" },
      }),
    );
  });
  expect(screen.getByText("http twenty-one")).toBeInTheDocument();
  expect(screen.queryByText("echo twenty-one")).not.toBeInTheDocument();
});

test("guards overlapping global older-page requests", async () => {
  let olderCalls = 0;
  let releaseOlder: ((response: Response) => void) | undefined;
  const olderResponse = new Promise<Response>((resolve) => {
    releaseOlder = resolve;
  });
  const row: ChatMessage = {
    id: 1 as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: "latest",
    mentions: [],
    createdAt: 1,
  };
  const olderRow: ChatMessage = {
    ...row,
    id: 0 as ChatMessage["id"],
    text: "older",
    createdAt: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url === "/api/chat/messages?before=1") {
        olderCalls += 1;
        return olderResponse;
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/");
  render(<App />);
  await screen.findByRole("heading", { name: "Open games" });
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: [row],
        cursor: 1,
        oldestRetainedId: 0,
        hasOlder: true,
        historyTruncated: true,
      }),
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("heading", { name: "Global chat" });
  const start = screen.getByTestId("virtualizer-start-reached");
  expect(screen.getByTestId("virtualizer-root")).toHaveAttribute("data-first-index", "100000");
  expect(screen.getByText("Earlier messages are no longer available")).toBeInTheDocument();
  fireEvent.click(start);
  fireEvent.click(start);
  expect(olderCalls).toBe(1);
  releaseOlder?.(new Response(JSON.stringify({ messages: [olderRow] }), { status: 200 }));
  expect(await screen.findByText("older")).toBeInTheDocument();
  expect(screen.getByTestId("virtualizer-root")).toHaveAttribute("data-first-index", "99999");
  expect(screen.getByText("Earlier messages are no longer available")).toBeInTheDocument();
});

test("holds at most 1000 global rows while retaining the truncation boundary", async () => {
  const rows: ChatMessage[] = Array.from({ length: 1_001 }, (_, index) => ({
    id: (index + 1) as ChatMessage["id"],
    userId: "other" as UserId,
    displayName: "Other",
    text: `message ${index + 1}`,
    mentions: [],
    createdAt: index + 1,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
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
  const socket = await vi.waitFor(() => {
    const current = StubWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    return current!;
  });
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: rows,
        cursor: 1_001,
        oldestRetainedId: 1,
        hasOlder: false,
        historyTruncated: false,
      }),
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  await screen.findByRole("heading", { name: "Global chat" });

  expect(screen.getByTestId("virtualizer-root")).toHaveAttribute("data-message-count", "1000");
  expect(screen.queryByText("message 1")).not.toBeInTheDocument();
  expect(screen.getByText("message 2")).toBeInTheDocument();
  expect(screen.getByText("Earlier messages are no longer available")).toBeInTheDocument();
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

test("preserves a failed draft and refreshes current candidates after INVALID_MENTION", async () => {
  let candidateCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url === "/api/chat/messages" && init?.method === "POST")
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "INVALID_MENTION" } }), { status: 422 }),
        );
      if (url.startsWith("/api/chat/mention-candidates?q=")) {
        candidateCalls += 1;
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const input = await screen.findByLabelText("Message");
  fireEvent.change(input, { target: { value: "hello @abc" } });
  await waitFor(() => expect(candidateCalls).toBe(1), { timeout: 1_000 });
  fireEvent.click(screen.getByLabelText("Send message"));

  await screen.findByRole("alert");
  expect(screen.getByLabelText("Message")).toHaveValue("hello @abc");
  await waitFor(() => expect(candidateCalls).toBeGreaterThanOrEqual(2), { timeout: 1_000 });
});

test("filters remote candidates by the current endpoint and ranks held recent IDs first", async () => {
  const candidateQueries: string[] = [];
  const historyRows: ChatMessage[] = [
    {
      id: 1 as ChatMessage["id"],
      userId: "old" as UserId,
      displayName: "Old Author",
      text: "old",
      mentions: [],
      createdAt: 1,
    },
    {
      id: 2 as ChatMessage["id"],
      userId: "recent" as UserId,
      displayName: "Recent Author",
      text: "recent",
      mentions: [],
      createdAt: 2,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url.startsWith("/api/chat/mention-candidates?q=")) {
        candidateQueries.push(new URL(url, "http://localhost").searchParams.get("q") ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { userId: "recent", displayName: "Alice" },
              { userId: "stranger", displayName: "Alicia" },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const input = await screen.findByLabelText("Message");
  await waitFor(() => expect(StubWebSocket.instances.at(-1)).toBeDefined());
  const socket = StubWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.receive(
      JSON.stringify({
        type: "history",
        messages: historyRows,
        cursor: 2,
        oldestRetainedId: 1,
        hasOlder: false,
        historyTruncated: false,
      }),
    );
  });
  fireEvent.change(input, { target: { value: "@ali" } });

  await waitFor(() => expect(candidateQueries).toContain("ali"), { timeout: 1_000 });
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
    "Alice, user recent",
    "Alicia, user stranger",
  ]);
  expect(screen.queryByRole("option", { name: /old/ })).not.toBeInTheDocument();
});

test("does not let an out-of-order candidate response replace the current query", async () => {
  const queries: string[] = [];
  let resolveOld: ((response: Response) => void) | undefined;
  let resolveNew: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === "/api/auth/get-session")
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "me", username: "wren" } }), {
            status: 200,
          }),
        );
      if (url.startsWith("/api/chat/mention-candidates?q=")) {
        const query = new URL(url, "http://localhost").searchParams.get("q") ?? "";
        queries.push(query);
        return new Promise<Response>((resolve) => {
          if (query === "old") resolveOld = resolve;
          else if (query === "new") resolveNew = resolve;
          else resolve(new Response(JSON.stringify([]), { status: 200 }));
        });
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
  window.history.replaceState({}, "", "/chat");
  render(<App />);

  const input = await screen.findByLabelText("Message");
  fireEvent.change(input, { target: { value: "@old" } });
  await waitFor(() => expect(queries).toContain("old"));
  fireEvent.change(input, { target: { value: "@new" } });
  await waitFor(() => expect(queries).toContain("new"));

  await act(async () => {
    resolveNew?.(
      new Response(JSON.stringify([{ userId: "new-user", displayName: "New Name" }]), {
        status: 200,
      }),
    );
  });
  expect(
    await screen.findByRole("option", { name: "New Name, user new-user" }),
  ).toBeInTheDocument();

  await act(async () => {
    resolveOld?.(
      new Response(JSON.stringify([{ userId: "old-user", displayName: "Old Name" }]), {
        status: 200,
      }),
    );
  });
  expect(screen.getByRole("option", { name: "New Name, user new-user" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Old Name, user old-user" })).not.toBeInTheDocument();
});
