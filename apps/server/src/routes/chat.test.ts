// Global chat routes: sending a message, and paging backwards through history.
// Realtime delivery is the hub's concern and is tested there; what matters
// here is validation, the rate limit, and that a committed message is fanned
// out rather than dropped.

import { expect, test } from "bun:test";
import type { Db } from "@werewolf/db";
import type { ChatMessage, ChatServerFrame, UserId } from "@werewolf/protocol";
import { normalizeMentionSearch } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { authUser } from "../auth/schema.ts";
import { as, jsonRequest, setup, USERS } from "../test/harness.ts";

async function addUser(db: Db, userId: string, username: string) {
  const timestamp = new Date(0);
  await db.insert(authUser).values({
    id: userId,
    name: username,
    username,
    usernameSearch: normalizeMentionSearch(username),
    email: `${userId}@example.test`,
    emailVerified: false,
    image: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

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
    jsonRequest("POST", { text: "  anyone up for a game at 21:00?  " }, USERS[0]!),
  );

  expect(response.status).toBe(201);
  const message = (await response.json()) as ChatMessage;
  expect(message.text).toBe("anyone up for a game at 21:00?");
  expect(message.userId as string).toBe(USERS[0]!);
  expect(message.displayName).toBe(USERS[0]!);
  expect(message.mentions).toEqual([]);
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

  expect(socket.frames.filter((entry) => entry.type === "message")).toHaveLength(1);
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
  expect(await response.json()).toEqual({ error: { code: "VALIDATION" } });
});

test("POST /api/chat/messages accepts exactly 500 canonical UTF-16 units", async () => {
  const { app } = await setup();

  const response = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "x".repeat(500) }),
  );

  expect(response.status).toBe(201);
});

test("POST /api/chat/messages persists structured mention metadata", async () => {
  const { app, db, chatRepo } = await setup();
  await addUser(db, USERS[1]!, "target");

  const response = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "  @target  ",
      mentions: [{ userId: USERS[1]!, start: 2, length: 7 }],
    }),
  );

  expect(response.status).toBe(201);
  const message = (await response.json()) as ChatMessage;
  expect(message.text).toBe("@target");
  expect(message.mentions).toEqual([{ userId: USERS[1]! as UserId, start: 0, length: 7 }]);
  expect((await chatRepo.listRecent(0))[0]?.mentions).toEqual(message.mentions);
});

test("invalid global mentions fail closed before insert and publish", async () => {
  const { app, db, chatRepo, chatHub, clock } = await setup();
  await addUser(db, USERS[1]!, "target");
  await addUser(db, USERS[2]!, "other");
  const originalAppend = chatRepo.append.bind(chatRepo);
  const originalPublish = chatHub.publish.bind(chatHub);
  let inserts = 0;
  let publishes = 0;
  chatRepo.append = (async (...args: Parameters<typeof originalAppend>) => {
    inserts += 1;
    return originalAppend(...args);
  }) as typeof chatRepo.append;
  chatHub.publish = (message) => {
    publishes += 1;
    originalPublish(message);
  };

  await db
    .update(authUser)
    .set({ username: "renamed", usernameSearch: normalizeMentionSearch("renamed") })
    .where(eq(authUser.id, USERS[1]!));

  const invalid = [
    {
      body: { text: "@missing", mentions: [{ userId: "missing", start: 0, length: 8 }] },
      code: "INVALID_MENTION",
    },
    {
      body: { text: "@u1", mentions: [{ userId: USERS[0]!, start: 0, length: 3 }] },
      code: "INVALID_MENTION",
    },
    {
      body: { text: "@target", mentions: [{ userId: USERS[1]!, start: 0, length: 7 }] },
      code: "INVALID_MENTION",
    },
    {
      body: { text: "@wrong", mentions: [{ userId: USERS[2]!, start: 0, length: 6 }] },
      code: "INVALID_MENTION",
    },
    {
      body: {
        text: "@one @two",
        mentions: [
          { userId: USERS[1]!, start: 0, length: 4 },
          { userId: USERS[2]!, start: 2, length: 4 },
        ],
      },
      code: "VALIDATION",
    },
    {
      body: { text: "@target", mentions: [{ userId: USERS[1]!, start: 1, length: 7 }] },
      code: "VALIDATION",
    },
    {
      body: { text: "@target", mentions: [{ userId: USERS[1]!, start: 0, length: 8 }] },
      code: "VALIDATION",
    },
  ] as const;
  for (const [index, candidate] of invalid.entries()) {
    clock.now += index === 0 ? 0 : 1000;
    const response = await as(
      app,
      USERS[0]!,
      "/api/chat/messages",
      jsonRequest("POST", candidate.body),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: candidate.code } });
  }

  const recipients = Array.from({ length: 9 }, (_, index) => `r${index}`);
  const text = recipients.map((id) => `@${id}`).join(" ");
  const mentions = recipients.map((id, index) => ({
    userId: id,
    start: recipients.slice(0, index).reduce((offset, previous) => offset + previous.length + 2, 0),
    length: id.length + 1,
  }));
  const ninth = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text, mentions }),
  );
  expect(ninth.status).toBe(400);
  expect(await ninth.json()).toEqual({ error: { code: "VALIDATION" } });
  expect(inserts).toBe(0);
  expect(publishes).toBe(0);
  expect(await chatRepo.listRecent(0)).toHaveLength(0);
});

test("an invalid mention does not consume the message rate slot", async () => {
  const { app, db } = await setup();
  await addUser(db, USERS[1]!, "target");

  const invalid = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "@stale",
      mentions: [{ userId: USERS[1]!, start: 0, length: 6 }],
    }),
  );
  const accepted = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "@target",
      mentions: [{ userId: USERS[1]!, start: 0, length: 7 }],
    }),
  );

  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: { code: "INVALID_MENTION" } });
  expect(accepted.status).toBe(201);
});

test("an accepted message consumes the one-second rate slot", async () => {
  const { app, db } = await setup();
  await addUser(db, USERS[1]!, "target");

  const first = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "@target",
      mentions: [{ userId: USERS[1]!, start: 0, length: 7 }],
    }),
  );
  const second = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", { text: "ordinary" }),
  );

  expect(first.status).toBe(201);
  expect(second.status).toBe(429);
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
      content: { text: `message ${index}`, mentions: [] },
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

test("mention search trims, returns authoritative candidates, and enforces its floor", async () => {
  const { app, db } = await setup();
  await addUser(db, USERS[1]!, "Alice");
  await addUser(db, USERS[2]!, "Álvaro");

  const result = await as(app, USERS[0]!, "/api/chat/mention-candidates?q=%20ali%20");
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual([{ userId: USERS[1]!, displayName: "Alice" }]);

  const belowFloor = await as(app, USERS[0]!, "/api/chat/mention-candidates?q=ab");
  const tooLong = await as(app, USERS[0]!, `/api/chat/mention-candidates?q=${"x".repeat(25)}`);
  expect(belowFloor.status).toBe(400);
  expect(tooLong.status).toBe(400);
  expect(await belowFloor.json()).toEqual({ error: { code: "VALIDATION" } });
  expect(await tooLong.json()).toEqual({ error: { code: "VALIDATION" } });
});

test("invalid searches do not consume quota and the rolling limit expires", async () => {
  const { app, clock } = await setup();
  for (let index = 0; index < 31; index += 1) {
    const response = await as(app, USERS[0]!, "/api/chat/mention-candidates?q=ab");
    expect(response.status).toBe(400);
  }
  for (let index = 0; index < 30; index += 1) {
    const response = await as(app, USERS[0]!, "/api/chat/mention-candidates?q=abc");
    expect(response.status).toBe(200);
  }
  expect((await as(app, USERS[0]!, "/api/chat/mention-candidates?q=abc")).status).toBe(429);
  clock.now += 10_001;
  expect((await as(app, USERS[0]!, "/api/chat/mention-candidates?q=abc")).status).toBe(200);
});

test("global mention validation uses current spelling after a rename", async () => {
  const { app, db, clock } = await setup();
  await addUser(db, USERS[1]!, "before");

  const before = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "@before",
      mentions: [{ userId: USERS[1]!, start: 0, length: 7 }],
    }),
  );
  await db
    .update(authUser)
    .set({ username: "after", usernameSearch: normalizeMentionSearch("after") })
    .where(eq(authUser.id, USERS[1]!));
  clock.now += 1000;
  const stale = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "@before",
      mentions: [{ userId: USERS[1]!, start: 0, length: 7 }],
    }),
  );
  const current = await as(
    app,
    USERS[0]!,
    "/api/chat/messages",
    jsonRequest("POST", {
      text: "@after",
      mentions: [{ userId: USERS[1]!, start: 0, length: 6 }],
    }),
  );

  expect(before.status).toBe(201);
  expect(stale.status).toBe(400);
  expect(await stale.json()).toEqual({ error: { code: "INVALID_MENTION" } });
  expect(current.status).toBe(201);
});
