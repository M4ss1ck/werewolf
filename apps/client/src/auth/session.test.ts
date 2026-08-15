import { afterEach, expect, test, vi } from "vitest";

import { signInWithGoogle } from "./session.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("Google sign-in follows the OAuth URL returned by Better Auth", async () => {
  const oauthUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=test";
  const location = { href: "http://localhost:1420/" };
  vi.stubGlobal("location", location);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: oauthUrl, redirect: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ),
  );

  await signInWithGoogle();

  expect(location.href).toBe(oauthUrl);
});
