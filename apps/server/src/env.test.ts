import { expect, test } from "bun:test";
import { loadEnv } from "./env.ts";

const base = {
  PORT: "3000",
  TURSO_DATABASE_URL: "file:./data/werewolf.db",
  BETTER_AUTH_SECRET: "secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
};

test("BETTER_AUTH_TRUSTED_ORIGINS absent parses to an empty list", () => {
  const env = loadEnv(base);
  expect(env.BETTER_AUTH_TRUSTED_ORIGINS).toEqual([]);
});

test("BETTER_AUTH_TRUSTED_ORIGINS splits on commas", () => {
  const env = loadEnv({ ...base, BETTER_AUTH_TRUSTED_ORIGINS: "a,b" });
  expect(env.BETTER_AUTH_TRUSTED_ORIGINS).toEqual(["a", "b"]);
});

test("BETTER_AUTH_TRUSTED_ORIGINS trims and drops empties", () => {
  const env = loadEnv({ ...base, BETTER_AUTH_TRUSTED_ORIGINS: " a , b ,, " });
  expect(env.BETTER_AUTH_TRUSTED_ORIGINS).toEqual(["a", "b"]);
});
