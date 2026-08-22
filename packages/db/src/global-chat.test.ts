// GlobalChatRepository: append with trim, and the two read paths that feed the
// socket's history frame and the client's backwards paging.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatContent, ChatMessageId, UserId } from "@werewolf/protocol";
import { migrate } from "drizzle-orm/libsql/migrator";

import { createDb, type Db } from "./client.ts";
import { CHAT_RETENTION, GlobalChatRepository } from "./global-chat.ts";
import { globalChatMessages } from "./schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

async function freshDb(): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-chat-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

/** Append `count` messages numbered from 1, returning the repository. */
async function seed(repo: GlobalChatRepository, count: number) {
  for (let index = 1; index <= count; index += 1)
    await repo.append({
      userId: "u1" as UserId,
      displayName: "Ana",
      content: { text: `message ${index}`, mentions: [] },
      createdAt: 1_000_000 + index,
    });
}

function content(text: string, mentions: ChatContent["mentions"] = []): ChatContent {
  return { text, mentions };
}

function cursor(value: number): ChatMessageId {
  return value as ChatMessageId;
}

test("append returns the stored message with its assigned id", async () => {
  const repo = new GlobalChatRepository(await freshDb());

  const message = await repo.append({
    userId: "u1" as UserId,
    displayName: "Ana",
    content: content("anyone up for a game at 21:00?"),
    createdAt: 1_000_000,
  });

  expect(message.id as number).toBe(1);
  expect(message.userId as string).toBe("u1");
  expect(message.displayName).toBe("Ana");
  expect(message.text).toBe("anyone up for a game at 21:00?");
  expect(message.mentions).toEqual([]);
  expect(message.createdAt).toBe(1_000_000);
});

test("append and reads round-trip content across ranges, including repeated user IDs", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  const mentions = [
    { userId: "u2" as UserId, start: 0, length: 4 },
    { userId: "u2" as UserId, start: 5, length: 4 },
  ];

  await repo.append({
    userId: "u1" as UserId,
    displayName: "Ana",
    content: content("@Bram @Bram", mentions),
    createdAt: 1_000_001,
  });
  await repo.append({
    userId: "u2" as UserId,
    displayName: "Bram",
    content: content("second"),
    createdAt: 1_000_002,
  });

  expect((await repo.listRecent(0)).map((message) => message.mentions)).toEqual([mentions, []]);
  expect((await repo.listBefore(2)).map((message) => message.text)).toEqual(["@Bram @Bram"]);
});

test("append uses the caller transaction for insert and retention", async () => {
  const db = await freshDb();
  const repo = new GlobalChatRepository(db);

  try {
    await db.transaction(async (tx) => {
      await repo.append(
        {
          userId: "u1" as UserId,
          displayName: "Ana",
          content: content("rolled back"),
          createdAt: 1_000_001,
        },
        tx,
      );
      throw new Error("rollback");
    });
  } catch (error) {
    expect(error).toEqual(new Error("rollback"));
  }

  expect(await repo.listRecent(0)).toEqual([]);
});

test("default, legacy, and malformed mention JSON map to an empty array", async () => {
  const db = await freshDb();
  const repo = new GlobalChatRepository(db);
  await db.insert(globalChatMessages).values({
    userId: "u1",
    displayName: "Ana",
    text: "default",
    createdAt: 1_000_001,
  });
  await db.insert(globalChatMessages).values({
    userId: "u1",
    displayName: "Ana",
    text: "legacy",
    mentionsJson: "null",
    createdAt: 1_000_002,
  });
  await db.insert(globalChatMessages).values({
    userId: "u1",
    displayName: "Ana",
    text: "malformed",
    mentionsJson: "not json",
    createdAt: 1_000_003,
  });
  await db.insert(globalChatMessages).values({
    userId: "u1",
    displayName: "Ana",
    text: "schema-invalid",
    mentionsJson: '[{"userId":"u1"}]',
    createdAt: 1_000_004,
  });

  expect((await repo.listRecent(0)).map((message) => message.mentions)).toEqual([[], [], [], []]);
});

test("listRecent returns the newest page, oldest-first", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 60);

  const messages = await repo.listRecent(0);

  expect(messages).toHaveLength(50);
  expect(messages[0]!.text).toBe("message 11");
  expect(messages.at(-1)!.text).toBe("message 60");
});

test("listRecent after a cursor returns only newer messages", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 10);

  const messages = await repo.listRecent(7);

  expect(messages.map((message) => message.text)).toEqual(["message 8", "message 9", "message 10"]);
});

test("listBefore returns the page immediately older, oldest-first", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 120);

  const messages = await repo.listBefore(71);

  expect(messages).toHaveLength(50);
  expect(messages[0]!.text).toBe("message 21");
  expect(messages.at(-1)!.text).toBe("message 70");
});

test("listBefore returns a short page at the start of retention", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 10);

  const messages = await repo.listBefore(4);

  expect(messages.map((message) => message.text)).toEqual(["message 1", "message 2", "message 3"]);
});

test("the trim keeps the newest CHAT_RETENTION messages and drops older ones", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, CHAT_RETENTION + 5);

  // The oldest surviving message is number 6; 1-5 were trimmed away.
  const oldest = await repo.listBefore(7);
  expect(oldest.map((message) => message.text)).toEqual(["message 6"]);
  // Seeding past the retention cap is a thousand round trips against a file
  // database, which outruns the default 5s timeout on a CI runner.
}, 30_000);

test("a cold subscription returns the latest 50 and the SQL maximum cursor", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 60);

  const window = await repo.listSubscriptionWindow(cursor(0));

  expect(window.messages).toHaveLength(50);
  expect(window.messages[0]!.id as number).toBe(11);
  expect(window.messages.at(-1)!.id as number).toBe(60);
  expect(window.cursor as number).toBe(60);
  expect(window.oldestRetainedId as number).toBe(1);
  expect(window.hasOlder).toBe(true);
  expect(window.historyTruncated).toBe(false);
});

test("a saved frontier returns 50 messages of context and every retained message after it", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 100);

  const window = await repo.listSubscriptionWindow(cursor(0), cursor(60));

  expect(window.messages).toHaveLength(90);
  expect(window.messages[0]!.id as number).toBe(11);
  expect(window.messages.at(-1)!.id as number).toBe(100);
  expect(window.cursor as number).toBe(100);
  expect(window.historyTruncated).toBe(false);
  expect(window.hasOlder).toBe(true);
});

test("a valid delivery cursor returns the entire unread retained tail", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 100);

  const window = await repo.listSubscriptionWindow(cursor(49));

  expect(window.messages).toHaveLength(51);
  expect(window.messages[0]!.id as number).toBe(50);
  expect(window.messages.at(-1)!.id as number).toBe(100);
  expect(window.cursor as number).toBe(100);
  expect(window.historyTruncated).toBe(false);
  expect(window.hasOlder).toBe(true);
});

test("a delivery cursor before retention returns the whole retained window with truncation", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, CHAT_RETENTION + 5);

  const window = await repo.listSubscriptionWindow(cursor(3));

  expect(window.messages).toHaveLength(CHAT_RETENTION);
  expect(window.messages[0]!.id as number).toBe(6);
  expect(window.messages.at(-1)!.id as number).toBe(CHAT_RETENTION + 5);
  expect(window.oldestRetainedId as number).toBe(6);
  expect(window.cursor as number).toBe(CHAT_RETENTION + 5);
  expect(window.historyTruncated).toBe(true);
  expect(window.hasOlder).toBe(false);
}, 30_000);

test("a saved zero frontier distinguishes an intact start from expired history", async () => {
  const intact = new GlobalChatRepository(await freshDb());
  await seed(intact, 10);
  const intactWindow = await intact.listSubscriptionWindow(cursor(0), cursor(0));
  expect(intactWindow.messages).toHaveLength(10);
  expect(intactWindow.oldestRetainedId as number).toBe(1);
  expect(intactWindow.historyTruncated).toBe(false);
  expect(intactWindow.hasOlder).toBe(false);

  const expired = new GlobalChatRepository(await freshDb());
  await seed(expired, CHAT_RETENTION + 5);
  const expiredWindow = await expired.listSubscriptionWindow(cursor(0), cursor(0));
  expect(expiredWindow.messages).toHaveLength(CHAT_RETENTION);
  expect(expiredWindow.oldestRetainedId as number).toBe(6);
  expect(expiredWindow.historyTruncated).toBe(true);
  expect(expiredWindow.hasOlder).toBe(false);
}, 30_000);

test("a frontier beyond the latest resets to the latest 50 without truncation", async () => {
  const repo = new GlobalChatRepository(await freshDb());
  await seed(repo, 60);

  const window = await repo.listSubscriptionWindow(cursor(0), cursor(70));

  expect(window.messages).toHaveLength(50);
  expect(window.messages[0]!.id as number).toBe(11);
  expect(window.messages.at(-1)!.id as number).toBe(60);
  expect(window.cursor as number).toBe(60);
  expect(window.historyTruncated).toBe(false);
});

test("oldest retained ID comes from SQL MIN for noncontiguous IDs", async () => {
  const db = await freshDb();
  const repo = new GlobalChatRepository(db);
  await db.insert(globalChatMessages).values([
    { id: 10, userId: "u1", displayName: "Ana", text: "ten", createdAt: 10 },
    { id: 100, userId: "u1", displayName: "Ana", text: "hundred", createdAt: 100 },
    { id: 1000, userId: "u1", displayName: "Ana", text: "thousand", createdAt: 1000 },
  ]);

  const window = await repo.listSubscriptionWindow(cursor(5));

  expect(window.oldestRetainedId as number).toBe(10);
  expect(window.cursor as number).toBe(1000);
  expect(window.messages.map((message) => message.id as number)).toEqual([10, 100, 1000]);
  expect(window.historyTruncated).toBe(true);
  expect(window.hasOlder).toBe(false);
});

test("an empty subscription window reports zero IDs and no flags", async () => {
  const repo = new GlobalChatRepository(await freshDb());

  expect(await repo.listSubscriptionWindow(cursor(0))).toEqual({
    messages: [],
    cursor: cursor(0),
    oldestRetainedId: cursor(0),
    hasOlder: false,
    historyTruncated: false,
  });
});
