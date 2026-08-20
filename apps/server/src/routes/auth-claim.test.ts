// GET /api/auth-claim: the Telegram Mini App's sign-in claim. The Mini App
// parks a nonce with the server, opens the browser leg, and polls this route
// until a one-time token (or an error) is parked under that nonce. The route
// is mounted before the requireViewer block, so an unauthenticated poll must
// answer pending rather than a 401 JSON body.

import { expect, test } from "bun:test";
import { authClaimRoutes, createHandoffClaims, HANDOFF_STATE_PATTERN } from "./auth-claim.ts";

const VALID_STATE = "abcdefghijklmnopqrstuvwxyz012345";

test("createHandoffClaims: take() returns null for an unknown state", () => {
  const claims = createHandoffClaims();
  expect(claims.take(VALID_STATE)).toBeNull();
});

test("createHandoffClaims: set() then take() returns the claim, and a second take() is null (single use)", () => {
  const claims = createHandoffClaims();
  claims.set(VALID_STATE, { ott: "t" });
  expect(claims.take(VALID_STATE)).toEqual({ ott: "t" });
  expect(claims.take(VALID_STATE)).toBeNull();
});

test("createHandoffClaims: an entry past CLAIM_TTL_MS is not returned", () => {
  let now = 1_000;
  const claims = createHandoffClaims(() => now);
  claims.set(VALID_STATE, { ott: "t" });
  // Advance past the TTL.
  now += 600_001;
  expect(claims.take(VALID_STATE)).toBeNull();
});

test("createHandoffClaims: set() prunes expired entries", () => {
  let now = 1_000;
  const claims = createHandoffClaims(() => now);
  claims.set("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { ott: "old" });
  now += 600_001;
  // A new set() prunes the expired one on write.
  claims.set("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { ott: "new" });
  expect(claims.take("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  expect(claims.take("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toEqual({ ott: "new" });
});

test("authClaimRoutes: a malformed or absent state is a 400 INVALID_STATE", async () => {
  const app = authClaimRoutes(createHandoffClaims());
  const absent = await app.request("/auth-claim");
  expect(absent.status).toBe(400);
  expect(await absent.json()).toEqual({ error: { code: "INVALID_STATE" } });

  const malformed = await app.request("/auth-claim?state=short");
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: { code: "INVALID_STATE" } });
});

test("authClaimRoutes: an unknown valid state is pending", async () => {
  const app = authClaimRoutes(createHandoffClaims());
  const response = await app.request(`/auth-claim?state=${VALID_STATE}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "pending" });
});

test("authClaimRoutes: a parked ott is ready once, then pending again", async () => {
  const claims = createHandoffClaims();
  claims.set(VALID_STATE, { ott: "t" });
  const app = authClaimRoutes(claims);

  const ready = await app.request(`/auth-claim?state=${VALID_STATE}`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready", ott: "t" });

  const again = await app.request(`/auth-claim?state=${VALID_STATE}`);
  expect(await again.json()).toEqual({ status: "pending" });
});

test("authClaimRoutes: a parked error is reported as error with its code", async () => {
  const claims = createHandoffClaims();
  claims.set(VALID_STATE, { code: "X" });
  const app = authClaimRoutes(claims);

  const response = await app.request(`/auth-claim?state=${VALID_STATE}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "error", code: "X" });
});

test("authClaimRoutes: every response carries cache-control: no-store", async () => {
  const claims = createHandoffClaims();
  claims.set(VALID_STATE, { ott: "t" });
  const app = authClaimRoutes(claims);

  const pending = await app.request(`/auth-claim?state=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`);
  expect(pending.headers.get("cache-control")).toBe("no-store");

  const ready = await app.request(`/auth-claim?state=${VALID_STATE}`);
  expect(ready.headers.get("cache-control")).toBe("no-store");

  const bad = await app.request("/auth-claim?state=short");
  expect(bad.headers.get("cache-control")).toBe("no-store");
});

test("HANDOFF_STATE_PATTERN matches the nonce shape", () => {
  expect(HANDOFF_STATE_PATTERN.test(VALID_STATE)).toBe(true);
  expect(HANDOFF_STATE_PATTERN.test("short")).toBe(false);
  expect(HANDOFF_STATE_PATTERN.test(`${VALID_STATE}/../`)).toBe(false);
});
