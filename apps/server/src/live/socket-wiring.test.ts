// The hub tests drive `connect` directly through a fake socket, so they pass
// even when nothing ever calls it. This one boots the app behind a real
// Bun.serve and talks to it over a real WebSocket, which is the only way to
// catch a server whose `websocket` handlers never reach Hono's dispatcher.

import { expect, test } from "bun:test";
import { games } from "@werewolf/db";
import {
  type ChatMessage,
  type ChatServerFrame,
  ChatServerFrameSchema,
  type GameId,
  type UserId,
} from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { websocket } from "hono/bun";
import { createApp } from "../app.ts";
import { setup, USERS } from "../test/harness.ts";
import { GameHub } from "./game-hub.ts";
import {
  GLOBAL_CHAT_HISTORY_BUDGET_BYTES,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from "./websocket-limits.ts";

function productionHistoryFrame() {
  const ids = Array.from({ length: 8 }, (_, index) => `${String(index).repeat(36)}`);
  const labels = ids.map((userId) => `@${userId}`);
  const mentions: ChatMessage["mentions"] = [];
  let escapedText = "";
  for (const [index, label] of labels.entries()) {
    const start = escapedText.length;
    escapedText += label;
    mentions.push({ userId: ids[index]! as UserId, start, length: label.length });
    if (index < labels.length - 1) escapedText += '\\"';
  }
  const remaining = 500 - escapedText.length;
  escapedText += '\\"'.repeat(Math.floor(remaining / 2));
  if (remaining % 2 === 1) escapedText += "\\";
  const messages: ChatMessage[] = Array.from({ length: 1000 }, (_, index) => ({
    id: (index + 1) as ChatMessage["id"],
    userId: ids[0]! as UserId,
    displayName: "n".repeat(24),
    text: escapedText,
    mentions,
    createdAt: 1_000_000 + index,
  }));
  return {
    type: "history" as const,
    messages,
    cursor: 1000,
    oldestRetainedId: 1,
    hasOlder: false,
    historyTruncated: false,
  };
}

test("the production-shaped history frame stays below the 4 MiB budget", () => {
  const frame = productionHistoryFrame();
  const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  expect(frame.messages[0]?.text).toHaveLength(500);
  for (const mention of frame.messages[0]?.mentions ?? [])
    expect(frame.messages[0]?.text.slice(mention.start, mention.start + mention.length)).toBe(
      `@${mention.userId}`,
    );
  expect(frame.messages[0]?.mentions).toHaveLength(8);
  expect(bytes).toBeLessThan(GLOBAL_CHAT_HISTORY_BUDGET_BYTES);
  expect(WEBSOCKET_MAX_PAYLOAD_BYTES).toBeGreaterThan(GLOBAL_CHAT_HISTORY_BUDGET_BYTES);
});

test("a chat subscriber over a real websocket receives its history", async () => {
  const { app, chatRepo } = await setup();
  await chatRepo.append({
    userId: USERS[0]! as UserId,
    displayName: "Ana",
    content: { text: "hello", mentions: [] },
    createdAt: 1_000_001,
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/chat/live`, {
      headers: { "x-user-id": USERS[0]! },
    });
    const frame = await new Promise<ChatServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame arrived")), 2_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe", cursor: 0 }));
      socket.onmessage = (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as ChatServerFrame);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket error"));
      };
    });

    expect(frame.type).toBe("history");
    if (frame.type !== "history") return;
    expect(ChatServerFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.messages.map((message) => message.text)).toEqual(["hello"]);
    expect(Number(frame.oldestRetainedId)).toBe(1);
    socket.close();
  } finally {
    server.stop(true);
  }
});

test("a real websocket receives and parses the production-shaped history frame", async () => {
  const { app, chatRepo } = await setup();
  chatRepo.listSubscriptionWindow = async () => {
    const frame = productionHistoryFrame();
    return {
      messages: frame.messages,
      cursor: frame.cursor as ChatMessage["id"],
      oldestRetainedId: frame.oldestRetainedId as ChatMessage["id"],
      hasOlder: frame.hasOlder,
      historyTruncated: frame.historyTruncated,
    };
  };

  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
    websocket: { ...websocket, maxPayloadLength: WEBSOCKET_MAX_PAYLOAD_BYTES },
  });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/chat/live`, {
      headers: { "x-user-id": USERS[0]! },
    });
    const frame = await new Promise<ChatServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame arrived")), 2_000);
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: "subscribe", cursor: 0, readCursor: 1 }));
      socket.onmessage = (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as ChatServerFrame);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket error"));
      };
    });

    expect(frame.type).toBe("history");
    expect(ChatServerFrameSchema.safeParse(frame).success).toBe(true);
    if (frame.type === "history") expect(frame.messages).toHaveLength(1000);
    socket.close();
  } finally {
    server.stop(true);
  }
});

test("a departed game subscriber is closed before the next live sync", async () => {
  const { coordinator, db, repo, app: _unusedApp } = await setup();
  const game = await (async () => {
    const response = await _unusedApp.request("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": USERS[0]! },
      body: JSON.stringify({ name: "Lobby" }),
    });
    const body = (await response.json()) as { gameId: string };
    return body.gameId;
  })();
  const joined = await _unusedApp.request(`/api/game-entry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": USERS[1]!,
      "x-username": USERS[1]!,
    },
    body: JSON.stringify({ reference: { kind: "public-game", gameId: game }, mode: "player" }),
  });
  expect(joined.status).toBe(200);
  await db.update(games).set({ visibility: "private" }).where(eq(games.id, game));

  const finishedResponse = await _unusedApp.request("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": USERS[0]! },
    body: JSON.stringify({ name: "Finished" }),
  });
  const finishedGame = ((await finishedResponse.json()) as { gameId: string }).gameId;
  await db.update(games).set({ status: "finished" }).where(eq(games.id, finishedGame));
  const replayCode = (await repo.getJoinCode(finishedGame as GameId))!;
  const replayAdmission = await _unusedApp.request("/api/game-entry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": USERS[3]!,
      "x-username": USERS[3]!,
    },
    body: JSON.stringify({
      reference: { kind: "invitation", code: replayCode },
      mode: "replay",
    }),
  });
  expect(replayAdmission.status).toBe(200);

  const hub = new GameHub(coordinator);
  const app = createApp({
    db,
    coordinator,
    gameHub: hub,
    sessionResolver: async (request) => {
      const userId = request.headers.get("x-user-id");
      return userId ? { userId, username: userId } : null;
    },
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  try {
    const unauthorized = new WebSocket(`ws://127.0.0.1:${server.port}/api/games/${game}/live`, {
      headers: { "x-user-id": USERS[2]! },
    });
    const unauthorizedResult = await new Promise<"open" | "error" | "close">((resolve) => {
      const timer = setTimeout(() => resolve("error"), 2_000);
      unauthorized.onopen = () => {
        clearTimeout(timer);
        resolve("open");
      };
      unauthorized.onerror = () => {
        clearTimeout(timer);
        resolve("error");
      };
      unauthorized.onclose = () => {
        clearTimeout(timer);
        resolve("close");
      };
    });
    expect(unauthorizedResult).not.toBe("open");
    unauthorized.close();

    const replayOnly = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/games/${finishedGame}/live`,
      { headers: { "x-user-id": USERS[3]! } },
    );
    const replayResult = await new Promise<"open" | "error" | "close">((resolve) => {
      const timer = setTimeout(() => resolve("error"), 2_000);
      replayOnly.onopen = () => {
        clearTimeout(timer);
        resolve("open");
      };
      replayOnly.onerror = () => {
        clearTimeout(timer);
        resolve("error");
      };
      replayOnly.onclose = () => {
        clearTimeout(timer);
        resolve("close");
      };
    });
    expect(replayResult).not.toBe("open");
    replayOnly.close();

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/games/${game}/live`, {
      headers: { "x-user-id": USERS[1]! },
    });
    const opened = await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not sync")), 2_000);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "subscribe", cursor: 0 }));
      };
      socket.onmessage = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket error"));
      };
    });
    expect(opened).toBeUndefined();

    const closed = new Promise<CloseEvent>((resolve) => {
      socket.onclose = resolve;
    });
    await coordinator.leaveLobby(game as GameId, USERS[1]! as UserId);
    const event = await closed;
    expect(event.code).toBe(1008);
    expect(event.reason).toBe(JSON.stringify({ error: { code: "GAME_NOT_FOUND" } }));
    socket.close();
  } finally {
    server.stop(true);
    hub.stop();
  }
});
