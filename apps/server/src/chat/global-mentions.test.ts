import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Db } from "@werewolf/db";
import { type ChatContent, normalizeMentionSearch, type UserId } from "@werewolf/protocol";
import { eq } from "drizzle-orm";
import { authUser, createAuthTables } from "../auth/schema.ts";
import {
  escapeLikePrefix,
  findGlobalMentionCandidates,
  validateGlobalMentions,
} from "./global-mentions.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup(): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-mention-test-"));
  const { client, db } = createDb(`file:${join(dir, "test.db")}`);
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await createAuthTables(client);
  return db;
}

async function seed(db: Db, rows: { id: string; username: string | null }[]): Promise<void> {
  await db.insert(authUser).values(
    rows.map(({ id, username }) => ({
      id,
      name: id,
      username,
      usernameSearch: username === null ? null : normalizeMentionSearch(username),
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })),
  );
}

const id = (value: string) => value as UserId;

test("escapeLikePrefix treats SQL wildcard characters literally", () => {
  expect(escapeLikePrefix("a\\b%c_d")).toBe("a\\\\b\\%c\\_d%");
});

test("mention search normalizes accents and case, ranks exact spelling first, and keeps duplicate names", async () => {
  const db = await setup();
  await seed(db, [
    { id: "viewer", username: "Álvaro" },
    { id: "z-alice", username: "alice" },
    { id: "a-alice", username: "Alice" },
    { id: "alvaro", username: "Alvaro" },
    { id: "accent", username: "Álondra" },
    { id: "none", username: null },
  ]);

  const exact = await findGlobalMentionCandidates(db, id("viewer"), "Al");
  expect(exact).toEqual([
    { userId: id("a-alice"), displayName: "Alice" },
    { userId: id("alvaro"), displayName: "Alvaro" },
    { userId: id("z-alice"), displayName: "alice" },
    { userId: id("accent"), displayName: "Álondra" },
  ]);
});

test("mention search escapes underscore, percent, and backslash prefixes", async () => {
  const db = await setup();
  await seed(db, [
    { id: "underscore", username: "foo_bar" },
    { id: "underscore-other", username: "fooXbar" },
    { id: "percent", username: "foo%bar" },
    { id: "percent-other", username: "fooXbar2" },
    { id: "slash", username: "foo\\bar" },
    { id: "slash-other", username: "fooXbar3" },
  ]);

  expect(await findGlobalMentionCandidates(db, id("sender"), "foo_")).toEqual([
    { userId: id("underscore"), displayName: "foo_bar" },
  ]);
  expect(await findGlobalMentionCandidates(db, id("sender"), "foo%")).toEqual([
    { userId: id("percent"), displayName: "foo%bar" },
  ]);
  expect(await findGlobalMentionCandidates(db, id("sender"), "foo\\")).toEqual([
    { userId: id("slash"), displayName: "foo\\bar" },
  ]);
});

test("mention search is deterministic and capped at eight rows", async () => {
  const db = await setup();
  await seed(
    db,
    Array.from({ length: 10 }, (_, index) => ({
      id: `user-${String(10 - index).padStart(2, "0")}`,
      username: `Player${String(index).padStart(2, "0")}`,
    })),
  );
  const candidates = await findGlobalMentionCandidates(db, id("sender"), "pla");
  expect(candidates).toHaveLength(8);
  expect(candidates.map((candidate) => candidate.userId)).toEqual([
    id("user-10"),
    id("user-09"),
    id("user-08"),
    id("user-07"),
    id("user-06"),
    id("user-05"),
    id("user-04"),
    id("user-03"),
  ]);
});

test("validateGlobalMentions checks current names, self, missing, null, and renamed targets", async () => {
  const db = await setup();
  await seed(db, [
    { id: "sender", username: "Sender" },
    { id: "target", username: "Alice" },
    { id: "null-name", username: null },
    { id: "renamed", username: "Current" },
  ]);
  const valid: ChatContent = {
    text: "@Alice and @Alice",
    mentions: [
      { userId: id("target"), start: 0, length: 6 },
      { userId: id("target"), start: 11, length: 6 },
    ],
  };
  expect(await validateGlobalMentions(db, id("sender"), valid)).toBe(true);
  expect(await validateGlobalMentions(db, id("sender"), { text: "hello", mentions: [] })).toBe(
    true,
  );

  for (const mention of [
    { userId: id("sender"), start: 0, length: 7 },
    { userId: id("missing"), start: 0, length: 6 },
    { userId: id("null-name"), start: 0, length: 6 },
    { userId: id("renamed"), start: 0, length: 6 },
  ]) {
    expect(
      await validateGlobalMentions(db, id("sender"), {
        text: "@Alice",
        mentions: [mention],
      }),
    ).toBe(false);
  }
  expect(
    await validateGlobalMentions(db, id("sender"), {
      text: "@Alicf",
      mentions: [{ userId: id("target"), start: 0, length: 6 }],
    }),
  ).toBe(false);
});

test("validation reads selected IDs together and rejects a mismatched visible slice", async () => {
  const db = await setup();
  await seed(db, [
    { id: "sender", username: "Sender" },
    { id: "one", username: "One" },
    { id: "two", username: "Two" },
  ]);
  expect(
    await validateGlobalMentions(db, id("sender"), {
      text: "@One @Two",
      mentions: [
        { userId: id("one"), start: 0, length: 4 },
        { userId: id("two"), start: 5, length: 4 },
      ],
    }),
  ).toBe(true);
  expect(
    await validateGlobalMentions(db, id("sender"), {
      text: "@One @Wrong",
      mentions: [
        { userId: id("one"), start: 0, length: 4 },
        { userId: id("two"), start: 5, length: 6 },
      ],
    }),
  ).toBe(false);
  const renamed = await db
    .update(authUser)
    .set({ username: "Changed", usernameSearch: "changed" })
    .where(eq(authUser.id, "two"));
  expect(renamed).toBeDefined();
  expect(
    await validateGlobalMentions(db, id("sender"), {
      text: "@One @Two",
      mentions: [
        { userId: id("one"), start: 0, length: 4 },
        { userId: id("two"), start: 5, length: 4 },
      ],
    }),
  ).toBe(false);
});
