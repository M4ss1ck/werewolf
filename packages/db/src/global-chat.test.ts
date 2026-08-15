// GlobalChatRepository: append with trim, and the two read paths that feed the
// socket's history frame and the client's backwards paging.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserId } from "@werewolf/protocol";
import { migrate } from "drizzle-orm/libsql/migrator";

import { createDb, type Db } from "./client.ts";
import { CHAT_RETENTION, GlobalChatRepository } from "./global-chat.ts";

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
      text: `message ${index}`,
      createdAt: 1_000_000 + index,
    });
}

test("append returns the stored message with its assigned id", async () => {
  const repo = new GlobalChatRepository(await freshDb());

  const message = await repo.append({
    userId: "u1" as UserId,
    displayName: "Ana",
    text: "anyone up for a game at 21:00?",
    createdAt: 1_000_000,
  });

  expect(message.id as number).toBe(1);
  expect(message.userId as string).toBe("u1");
  expect(message.displayName).toBe("Ana");
  expect(message.text).toBe("anyone up for a game at 21:00?");
  expect(message.createdAt).toBe(1_000_000);
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
});
