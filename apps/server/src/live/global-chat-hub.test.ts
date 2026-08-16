// GlobalChatHub tests. The hub is driven through its connect seam with a fake
// socket that records frames; no real TCP connection is involved. Unlike the
// game hub there is no per-viewer filtering — everyone sees everything — so
// what is exercised here is history, cursors and fanout.

import { expect, test } from "bun:test";
import type { ChatServerFrame, UserId } from "@werewolf/protocol";
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

async function subscribe(conn: { message(raw: string): Promise<void> }, cursor: number) {
  await conn.message(JSON.stringify({ type: "subscribe", cursor }));
}

test("a subscriber receives the recent history and a cursor", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 3; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      text: `message ${index}`,
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
});

test("a subscriber reconnecting with a cursor receives only what it missed", async () => {
  const { chatRepo, chatHub } = await setup();
  for (let index = 1; index <= 3; index += 1)
    await chatRepo.append({
      userId: USERS[0]! as UserId,
      displayName: "Ana",
      text: `message ${index}`,
      createdAt: 1_000_000 + index,
    });
  const socket = fakeSocket();

  await subscribe(chatHub.connect(viewer(USERS[0]!), socket), 2);

  const history = socket.frames[0];
  if (history?.type !== "history") throw new Error("expected a history frame");
  expect(history.messages.map((message) => message.text)).toEqual(["message 3"]);
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
    text: "21:00 works",
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
      text: "silence",
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
    text: "seed",
    createdAt: 1_000_000,
  });

  // Gate listRecent's return (not its query) so we can commit and publish a
  // message after the SELECT ran but before `subscribed` flips to true —
  // exactly the window the fix must cover.
  const originalListRecent = chatRepo.listRecent.bind(chatRepo);
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  chatRepo.listRecent = (async (...args: Parameters<typeof originalListRecent>) => {
    const result = await originalListRecent(...args);
    await gate;
    return result;
  }) as typeof chatRepo.listRecent;

  const socket = fakeSocket();
  const connection = chatHub.connect(viewer(USERS[0]!), socket);
  const subscribed = subscribe(connection, 0);

  const racing = await chatRepo.append({
    userId: USERS[1]! as UserId,
    displayName: "Bram",
    text: "racing",
    createdAt: 1_000_001,
  });
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

test("closing a connection removes the subscriber", async () => {
  const { chatHub } = await setup();
  const socket = fakeSocket();
  const connection = chatHub.connect(viewer(USERS[0]!), socket);
  await subscribe(connection, 0);
  expect(chatHub.subscriberCount()).toBe(1);

  connection.close();

  expect(chatHub.subscriberCount()).toBe(0);
});
