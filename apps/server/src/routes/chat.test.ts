// Global chat routes: sending a message, and paging backwards through history.
// Realtime delivery is the hub's concern and is tested there; what matters
// here is validation, the rate limit, and that a committed message is fanned
// out rather than dropped.

import { expect, test } from "bun:test";
import type { ChatMessage, ChatServerFrame, UserId } from "@werewolf/protocol";
import { as, jsonRequest, setup, USERS } from "../test/harness.ts";

function fakeSocket() {
  const frames: ChatServerFrame[] = [];
  return {
    frames,
    send(data: string) {
      frames.push(JSON.parse(data) as ChatServerFrame);
    },
  };
}

test("POST /api/chat/messages stores the message and answers with it", async () => {
  const { app, chatRepo } = await setup();

  const response = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "anyone up for a game at 21:00?" }, USERS[0]!),
  );

  expect(response.status).toBe(201);
  const message = (await response.json()) as ChatMessage;
  expect(message.text).toBe("anyone up for a game at 21:00?");
  expect(message.userId as string).toBe(USERS[0]!);
  expect(message.displayName).toBe(USERS[0]!);
  expect(await chatRepo.listRecent(0)).toHaveLength(1);
});

test("POST /api/chat/messages broadcasts to subscribers", async () => {
  const { app, chatHub } = await setup();
  const socket = fakeSocket();
  const connection = chatHub.connect(
    { userId: USERS[1]! as UserId, displayName: USERS[1]! },
    socket,
  );
  await connection.message(JSON.stringify({ type: "subscribe", cursor: 0 }));

  await as(app, USERS[0]!, "/api/chat/messages", jsonRequest("POST", { text: "21:00 works" }));

  const frame = socket.frames.at(-1);
  expect(frame?.type).toBe("message");
  if (frame?.type !== "message") return;
  expect(frame.message.text).toBe("21:00 works");
});

test("POST /api/chat/messages refuses an empty message", async () => {
  const { app } = await setup();

  const response = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "   " }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "VALIDATION" } });
});

test("POST /api/chat/messages refuses a message over 500 characters", async () => {
  const { app } = await setup();

  const response = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "x".repeat(501) }),
  );

  expect(response.status).toBe(400);
});

test("POST /api/chat/messages rate-limits a second message within a second", async () => {
  const { app } = await setup();

  const first = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "one" }),
  );
  const second = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "two" }),
  );

  expect(first.status).toBe(201);
  expect(second.status).toBe(429);
  expect(await second.json()).toEqual({ error: { code: "RATE_LIMITED" } });
});

test("advancing the clock past the rate limit window allows the next message", async () => {
  const { app, clock } = await setup();

  const first = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "one" }),
  );
  clock.now += 999;
  const stillLimited = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "two" }),
  );
  clock.now += 1;
  const allowed = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "three" }),
  );

  expect(first.status).toBe(201);
  expect(stillLimited.status).toBe(429);
  expect(allowed.status).toBe(201);
});

test("the rate limit is per player, not global", async () => {
  const { app } = await setup();

  await as(app, USERS[0]!, "/api/chat/messages", jsonRequest("POST", { text: "one" }, USERS[0]!));
  const other = await as(
    app,
    USERS[1]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "two" }, USERS[1]!),
  );

  expect(other.status).toBe(201);
});

test("POST /api/chat/messages without a viewer is refused", async () => {
  const { app } = await setup();

  const response = await app.request("/api/chat/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});

test("GET /api/chat/messages returns the page older than the cursor", async () => {
  const { app, chatRepo } = await setup();
  for (let index = 1; index <= 5; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      text: `message ${index}`,
      createdAt: 1_000_000 + index,
    });

  const response = await as(app, USERS[0]!, "/api/chat/messages?before=4");

  expect(response.status).toBe(200);
  const body = (await response.json()) as { messages: ChatMessage[] };
  expect(body.messages.map((message) => message.text)).toEqual([
    "message 1",
    "message 2",
    "message 3",
  ]);
});

test("GET /api/chat/messages without a valid before cursor is refused", async () => {
  const { app } = await setup();

  const missing = await as(app, USERS[0]!, "/api/chat/messages");
  const nonsense = await as(app, USERS[0]!, "/api/chat/messages?before=abc");

  expect(missing.status).toBe(400);
  expect(nonsense.status).toBe(400);
});
