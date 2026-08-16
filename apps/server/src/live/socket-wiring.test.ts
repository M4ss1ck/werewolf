// The hub tests drive `connect` directly through a fake socket, so they pass
// even when nothing ever calls it. This one boots the app behind a real
// Bun.serve and talks to it over a real WebSocket, which is the only way to
// catch a server whose `websocket` handlers never reach Hono's dispatcher.

import { expect, test } from "bun:test";
import type { ChatServerFrame, UserId } from "@werewolf/protocol";
import { websocket } from "hono/bun";
import { setup, USERS } from "../test/harness.ts";

test("a chat subscriber over a real websocket receives its history", async () => {
  const { app, chatRepo } = await setup();
  await chatRepo.append({
    userId: USERS[0]! as UserId,
    displayName: "Ana",
    text: "hello",
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
    expect(frame.messages.map((message) => message.text)).toEqual(["hello"]);
    socket.close();
  } finally {
    server.stop(true);
  }
});
