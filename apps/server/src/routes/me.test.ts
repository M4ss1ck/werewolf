// Username routes: a signed-in player chooses the name the roster shows. The
// username lives on the Better Auth user table; tests insert a row because the
// harness now creates the auth tables alongside the game tables.

import { expect, test } from "bun:test";
import type { Db } from "@werewolf/db";
import { eq } from "drizzle-orm";
import { authUser } from "../auth/schema.ts";
import { as, jsonRequest, setup, USERS } from "../test/harness.ts";

async function withUser(db: Db, id: string) {
  await db.insert(authUser).values({
    id,
    name: "Test User",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

test("PATCH /api/me/username stores the chosen username", async () => {
  const { app, db } = await setup();
  await withUser(db, USERS[0]!);

  const response = await as(
    app,
    USERS[0]!,
    "/api/me/username",
    jsonRequest("PATCH", { username: "Moonwatcher" }, USERS[0]!),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: USERS[0]!, username: "Moonwatcher" });

  const row = await db.select().from(authUser).where(eq(authUser.id, USERS[0]!)).get();
  expect(row?.username).toBe("Moonwatcher");
});

test("PATCH /api/me/username with a too-short username is refused", async () => {
  const { app, db } = await setup();
  await withUser(db, USERS[0]!);

  const response = await as(
    app,
    USERS[0]!,
    "/api/me/username",
    jsonRequest("PATCH", { username: "ab" }, USERS[0]!),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "INVALID_USERNAME" } });
});

test("PATCH /api/me/username with invalid edge characters is refused", async () => {
  const { app, db } = await setup();
  await withUser(db, USERS[0]!);

  const response = await as(
    app,
    USERS[0]!,
    "/api/me/username",
    jsonRequest("PATCH", { username: "-bad-" }, USERS[0]!),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "INVALID_USERNAME" } });
});

test("PATCH /api/me/username without a viewer is refused", async () => {
  const { app } = await setup();

  const response = await app.request("/api/me/username", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Moonwatcher" }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
});
