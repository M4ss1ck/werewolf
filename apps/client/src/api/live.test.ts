import type { EventId, GameEvent, GameId, PhaseId, ViewerGameSnapshot } from "@werewolf/protocol";
import { afterEach, expect, test, vi } from "vitest";

import { LiveGameConnection, type LiveStatus } from "./live.ts";

/** Minimal WebSocket stand-in: records instances, exposes the event handlers
 * the live client wires up, and lets a test drive open/receive/drop. */
class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test helpers. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(data: string) {
    this.onmessage?.({ data });
  }
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const gameId = "game-1" as GameId;

function makeSnapshot(cursor: number): ViewerGameSnapshot {
  return {
    game: {
      id: gameId,
      name: "Lobby 1",
      ownerUserId: "owner-1" as ViewerGameSnapshot["game"]["ownerUserId"],
      status: "lobby",
      day: 1,
      phase: null,
      settings: {
        visibility: "public",
        spectatingEnabled: true,
        durations: { discussion: 60, voting: 60, night: 60 },
      },
    },
    players: [],
    availableActions: [],
    availableChannels: ["public"],
    cursor: cursor as EventId,
    serverNow: 1000,
  };
}

function makeEvent(id: number): GameEvent {
  return {
    id: id as EventId,
    kind: "phase.started",
    scope: "public",
    createdAt: 1000 + id,
    payload: {
      phaseId: id as PhaseId,
      type: "discussion",
      startedAt: 1000,
      endsAt: 1060,
    },
  };
}

function lastSocket() {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no WebSocket was created");
  return socket;
}

function sentFrame(socket: FakeWebSocket) {
  return JSON.parse(socket.sent[0]!) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances.length = 0;
});

test("subscribes with the current cursor and applies a sync frame's snapshot", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const onSnapshot = vi.fn();
  const conn = new LiveGameConnection(gameId, 7 as EventId, { onSnapshot });
  conn.connect();
  const socket = lastSocket();
  socket.open();

  expect(sentFrame(socket)).toMatchObject({ type: "subscribe", cursor: 7 });

  socket.receive(
    JSON.stringify({
      type: "sync",
      snapshot: makeSnapshot(9),
      events: [],
      cursor: 9,
    }),
  );
  expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ cursor: 9 }));
  expect(conn.getSnapshot()).toMatchObject({ cursor: 9 });
});

test("advances the cursor as events arrive, so a reconnect subscribes from the newer cursor", () => {
  vi.useFakeTimers();
  const conn = new LiveGameConnection(gameId, 0 as EventId);
  try {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    conn.connect();
    const socket = lastSocket();
    socket.open();

    socket.receive(
      JSON.stringify({ type: "sync", snapshot: makeSnapshot(3), events: [], cursor: 3 }),
    );
    expect(conn.getCursor()).toBe(3);

    socket.receive(JSON.stringify({ type: "event", event: makeEvent(4) }));
    socket.receive(JSON.stringify({ type: "event", event: makeEvent(5) }));
    expect(conn.getCursor()).toBe(5);

    // The connection drops and reconnects: the new subscription must resume
    // from the advanced cursor, not replay from the start.
    socket.drop();
    expect(conn.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    const reconnected = lastSocket();
    reconnected.open();

    expect(sentFrame(reconnected)).toMatchObject({ type: "subscribe", cursor: 5 });
  } finally {
    conn.close();
    vi.useRealTimers();
  }
});

test("resync_required reloads the snapshot over HTTP instead of patching local state", async () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const fresh = makeSnapshot(42);
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fresh), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const onSnapshot = vi.fn();
  const onEvent = vi.fn();
  const conn = new LiveGameConnection(gameId, 0 as EventId, { onSnapshot, onEvent });
  conn.connect();
  const socket = lastSocket();
  socket.open();

  socket.receive(
    JSON.stringify({
      type: "sync",
      snapshot: makeSnapshot(3),
      events: [makeEvent(1), makeEvent(2)],
      cursor: 3,
    }),
  );
  onSnapshot.mockClear();
  onEvent.mockClear();

  socket.receive(JSON.stringify({ type: "resync_required" }));
  // The resync path fetches the snapshot over HTTP and replaces local state;
  // wait for that outcome rather than for the fetch call itself.
  await vi.waitFor(() => expect(conn.getCursor()).toBe(42));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/games/game-1",
    expect.objectContaining({ credentials: "include" }),
  );
  expect(conn.getSnapshot()).toMatchObject({ cursor: 42 });
  expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ cursor: 42 }));
  // A reload replaces state; nothing is patched from the socket.
  expect(onEvent).not.toHaveBeenCalled();
});

test("a dropped connection reports reconnecting while the last snapshot stays readable", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const statuses: LiveStatus[] = [];
  const conn = new LiveGameConnection(gameId, 0 as EventId, {
    onStatus: (status) => statuses.push(status),
  });
  conn.connect();
  const socket = lastSocket();
  socket.open();

  socket.receive(
    JSON.stringify({ type: "sync", snapshot: makeSnapshot(3), events: [], cursor: 3 }),
  );
  expect(conn.getSnapshot()).toMatchObject({ cursor: 3 });

  socket.drop();

  expect(conn.getStatus()).toBe("reconnecting");
  expect(statuses).toContain("reconnecting");
  // The UI must not blank out: the snapshot received before the drop is kept.
  expect(conn.getSnapshot()).toMatchObject({ cursor: 3 });
  conn.close();
});
