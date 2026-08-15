import type { ChatMessage, ChatMessageId, UserId } from "@werewolf/protocol";
import { afterEach, expect, test, vi } from "vitest";

import { GlobalChatConnection } from "./chat-live.ts";

/** Minimal WebSocket stand-in: records instances, exposes the event handlers
 * the chat client wires up, and lets a test drive open/receive/drop. */
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

function message(id: number): ChatMessage {
  return {
    id: id as ChatMessageId,
    userId: "u1" as UserId,
    displayName: "Ana",
    text: `message ${id}`,
    createdAt: 1_000_000 + id,
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

test("a cold open subscribes with cursor 0 by default", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const conn = new GlobalChatConnection();
  conn.connect();
  const socket = lastSocket();
  socket.open();

  expect(sentFrame(socket)).toMatchObject({ type: "subscribe", cursor: 0 });

  conn.close();
});

test("a connection seeded with a cursor subscribes from it, not from 0", () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const conn = new GlobalChatConnection({}, 42 as ChatMessageId);
  conn.connect();
  const socket = lastSocket();
  socket.open();

  expect(sentFrame(socket)).toMatchObject({ type: "subscribe", cursor: 42 });

  conn.close();
});

test("the cursor advances as frames arrive, so a reconnect subscribes from the newer cursor", () => {
  vi.useFakeTimers();
  const conn = new GlobalChatConnection();
  try {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    conn.connect();
    const socket = lastSocket();
    socket.open();

    socket.receive(
      JSON.stringify({ type: "history", messages: [message(1), message(2)], cursor: 2 }),
    );
    socket.receive(JSON.stringify({ type: "message", message: message(3) }));

    // The connection drops and reconnects: the new subscription must resume
    // from the advanced cursor, not replay from the start.
    socket.drop();
    vi.advanceTimersByTime(1000);
    const reconnected = lastSocket();
    reconnected.open();

    expect(sentFrame(reconnected)).toMatchObject({ type: "subscribe", cursor: 3 });
  } finally {
    conn.close();
    vi.useRealTimers();
  }
});
