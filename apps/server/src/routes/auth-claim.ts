// GET /api/auth-claim: the Telegram Mini App's half of sign-in. A Mini App is
// an embedded webview, and Google answers OAuth in one with 403
// disallowed_useragent, so it opens the leg in a real browser the way the
// packaged app does. But a webview can neither bind a loopback port nor
// register a custom scheme, so there is no redirect to come home through.
// Instead the Mini App generates a nonce, opens the browser leg with it, and
// polls this route until the server has parked a one-time token under that
// nonce. The Mini App — which openLink() leaves running — asks for it.

import { Hono } from "hono";

export const TELEGRAM_HANDOFF_COOKIE = "werewolf.tg-handoff";
export const HANDOFF_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type HandoffClaim = { ott: string } | { code: string };
export type HandoffClaims = {
  set(state: string, claim: HandoffClaim): void;
  take(state: string): HandoffClaim | null;
};

const CLAIM_TTL_MS = 600_000;

export function createHandoffClaims(now: () => number = Date.now): HandoffClaims {
  const claims = new Map<string, { claim: HandoffClaim; expiresAt: number }>();

  return {
    set(state, claim) {
      // Prune on write, deliberately: no setInterval, no timers. A claim that
      // is never polled simply expires and is swept the next time one is set.
      for (const [key, entry] of claims) {
        if (entry.expiresAt <= now()) claims.delete(key);
      }
      claims.set(state, { claim, expiresAt: now() + CLAIM_TTL_MS });
    },
    take(state) {
      const entry = claims.get(state);
      if (!entry || entry.expiresAt <= now()) return null;
      claims.delete(state);
      return entry.claim;
    },
  };
}

export function authClaimRoutes(claims: HandoffClaims) {
  const app = new Hono();

  app.get("/auth-claim", (c) => {
    c.header("cache-control", "no-store");
    const state = c.req.query("state");
    if (state === undefined || !HANDOFF_STATE_PATTERN.test(state)) {
      return c.json({ error: { code: "INVALID_STATE" } }, 400);
    }
    const claim = claims.take(state);
    if (claim === null) return c.json({ status: "pending" });
    if ("ott" in claim) return c.json({ status: "ready", ott: claim.ott });
    return c.json({ status: "error", code: claim.code });
  });

  return app;
}
