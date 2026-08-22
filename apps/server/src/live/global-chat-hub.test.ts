// GlobalChatHub tests. The hub is driven through its connect seam with a fake
// socket that records frames; no real TCP connection is involved. Unlike the
// game hub there is no per-viewer filtering — everyone sees everything — so
// what is exercised here is history, cursors and fanout.

import { expect, test } from "bun:test";
import type { ChatMessageId, ChatServerFrame, UserId } from "@werewolf/protocol";
import { setup, USERS } from "../test/harness.ts";

function fakeSocket() {
  const frames: ChatServerFrame[] = [];
  return {
    frames,
    send(data: string) {
      frames.push(JSON.parse(data) as ChatServerFrame);
    },
  };
}

function viewer(userId: string) {
  return { userId: userId as UserId, displayName: userId };
}

async function subscribe(
  conn: { message(raw: string): Promise<void> },
  cursor: number,
  readCursor?: number,
) {
  await conn.message(
    JSON.stringify({
      type: "subscribe",
      cursor,
      ...(readCursor === undefined ? {} : { readCursor }),
    }),
  );
}

test("a subscriber receives the recent history and a cursor", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 3; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 0);

  const history = socket.frames[0];
  expect(history?.type).toBe("history");
  if (history?.type !== "history") return;
  expect(history.messages.map((message) => message.text)).toEqual([
    "message 1",
    "message 2",
    "message 3",
  ]);
  expect(history.cursor as number).toBe(3);
  expect(history.oldestRetainedId as number).toBe(1);
  expect(history.hasOlder).toBe(false);
  expect(history.historyTruncated).toBe(false);
});

test("a cold subscriber receives the latest 50 and retained boundary metadata", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 55; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 0);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => Number(message.id))).toEqual(
    Array.from({ length: 50 }, (_, index) => index + 6),
  );
  expect(Number(history.cursor)).toBe(55);
  expect(Number(history.oldestRetainedId)).toBe(1);
  expect(history.hasOlder).toBe(true);
  expect(history.historyTruncated).toBe(false);
});

test("a saved read cursor receives context and every retained unread row", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 100; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 0, 80);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => Number(message.id))).toEqual(
    Array.from({ length: 70 }, (_, index) => index + 31),
  );
  expect(Number(history.cursor)).toBe(100);
});

test("a subscriber reconnecting with a cursor receives only what it missed", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 3; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 2);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => message.text)).toEqual(["message 3"]);
});

test("delivery cursor takes precedence over a saved read cursor on reconnect", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 5; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 2, 1);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => Number(message.id))).toEqual([3, 4, 5]);
});

test("a cursor before retention returns the retained window and truncation metadata", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 1001; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 1);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(Number(history.messages[0]?.id)).toBe(2);
  expect(history.messages).toHaveLength(1000);
  expect(Number(history.cursor)).toBe(1001);
  expect(Number(history.oldestRetainedId)).toBe(2);
  expect(history.historyTruncated).toBe(true);
});

test("a cursor beyond latest resets to the latest context", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 3; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 99, 99);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => Number(message.id))).toEqual([1, 2, 3]);
  expect(Number(history.cursor)).toBe(3);
  expect(history.historyTruncated).toBe(false);
});

test("the history cursor stays at SQL latest when a cursor returns no rows", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 3; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 3);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages).toEqual([]);
  expect(Number(history.cursor)).toBe(3);
  expect(Number(history.oldestRetainedId)).toBe(1);
});

test("a published message reaches every subscribed socket", async () => {
  const { chatRepo, chatHub } = await setup();
  const first = fakeSocket();
  const second = fakeSocket();
  await subscribe(chatHub.connect(viewer(USERS[0]!), first), 0);
  await subscribe(chatHub.connect(viewer(USERS[1]!), second), 0);

  const message = await chatRepo.append({
    userId: USERS[0]! as UserId,
    displayName: "Ana",
    content: { text: "21:00 works", mentions: [] },
    createdAt: 1_000_001,
  });
  chatHub.publish(message);

  for (const socket of [first, second]) {
    const frame = socket.frames.at(-1);
    expect(frame?.type).toBe("message");
    if (frame?.type !== "message") continue;
    expect(frame.message.text).toBe("21:00 works");
  }
});

test("a socket that never subscribed receives nothing", async () => {
  const { chatRepo, chatHub } = await setup();
  const socket = fakeSocket();
  chatHub.connect(viewer(USERS[0]!), socket);

  chatHub.publish(
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      content: { text: "silence", mentions: [] },
      createdAt: 1_000_001,
    }),
  );

  expect(socket.frames).toHaveLength(0);
});

test("a message published during the subscribe window is delivered once, and one already in the history page is not duplicated", async () => {
  const { chatRepo, chatHub } = await setup();
  const seeded = await chatRepo.append({
    userId: USERS[0]! as UserId,
    displayName: "Ana",
    content: { text: "seed", mentions: [] },
    createdAt: 1_000_000,
  });

  // Gate listSubscriptionWindow's return (not its transaction) so we can
  // publish a message after the consistent SELECT completed but before
  // `subscribed` flips to true — exactly the window the fix must cover.
  const originalListSubscriptionWindow = chatRepo.listSubscriptionWindow.bind(chatRepo);
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let queryComplete = () => {};
  const queryFinished = new Promise<void>((resolve) => {
    queryComplete = resolve;
  });
  chatRepo.listSubscriptionWindow = (async (
    ...args: Parameters<typeof originalListSubscriptionWindow>
  ) => {
    const result = await originalListSubscriptionWindow(...args);
    queryComplete();
    await gate;
    return result;
  }) as typeof chatRepo.listSubscriptionWindow;

  const socket = fakeSocket();
  const connection = chatHub.connect(viewer(USERS[0]!), socket);
  const subscribed = subscribe(connection, 0);

  await queryFinished;
  const racing = await chatRepo.append({
    userId: USERS[1]! as UserId,
    displayName: "Bram",
    content: { text: "racing", mentions: [] },
    createdAt: 1_000_001,
  });
  chatHub.publish(racing);
  chatHub.publish(racing);
  // A redundant publish of a message already captured by the SELECT must be
  // filtered out, not delivered a second time.
  chatHub.publish(seeded);

  releaseGate();
  await subscribed;

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => message.text)).toEqual(["seed"]);

  const rest = socket.frames.slice(1);
  expect(rest).toHaveLength(1);
  const frame = rest[0];
  expect(frame?.type).toBe("message");
  if (frame?.type === "message") expect(frame.message.text).toBe("racing");
});

test("duplicate subscribe frames share one in-flight history query", async () => {
  const { chatRepo, chatHub } = await setup();
  const originalListSubscriptionWindow = chatRepo.listSubscriptionWindow.bind(chatRepo);
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let queries = 0;
  chatRepo.listSubscriptionWindow = (async (
    ...args: Parameters<typeof originalListSubscriptionWindow>
  ) => {
    queries += 1;
    const result = await originalListSubscriptionWindow(...args);
    await gate;
    return result;
  }) as typeof chatRepo.listSubscriptionWindow;

  const socket = fakeSocket();
  const connection = chatHub.connect(viewer(USERS[0]!), socket);
  const first = connection.message(JSON.stringify({ type: "subscribe", cursor: 0 }));
  const second = connection.message(JSON.stringify({ type: "subscribe", cursor: 0 }));
  releaseGate();
  await Promise.all([first, second]);

  expect(queries).toBe(1);
  expect(socket.frames.filter((frame) => frame.type === "history")).toHaveLength(1);
});

test("closing during a history query prevents history and pending delivery", async () => {
  const { chatRepo, chatHub } = await setup();
  const originalListSubscriptionWindow = chatRepo.listSubscriptionWindow.bind(chatRepo);
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  chatRepo.listSubscriptionWindow = (async (
    ...args: Parameters<typeof originalListSubscriptionWindow>
  ) => {
    const result = await originalListSubscriptionWindow(...args);
    await gate;
    return result;
  }) as typeof chatRepo.listSubscriptionWindow;

  const socket = fakeSocket();
  const connection = chatHub.connect(viewer(USERS[0]!), socket);
  const subscribing = connection.message(JSON.stringify({ type: "subscribe", cursor: 0 }));
  chatHub.publish({
    id: 1 as ChatMessageId,
    userId: USERS[1]! as UserId,
    displayName: "Bram",
    text: "pending",
    mentions: [],
    createdAt: 1_000_001,
  });
  connection.close();
  releaseGate();
  await subscribing;

  expect(socket.frames).toHaveLength(0);
  expect(chatHub.subscriberCount()).toBe(0);
});

test("closing a connection removes the subscriber", async () => {
  const { chatHub } = await setup();
  const socket = fakeSocket();
  const connection = chatHub.connect(viewer(USERS[0]!), socket);
  await subscribe(connection, 0);
  expect(chatHub.subscriberCount()).toBe(1);

  connection.close();

  expect(chatHub.subscriberCount()).toBe(0);
});
