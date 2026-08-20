import { afterEach, expect, test, vi } from "vitest";

import { signInWithGoogle } from "./session.ts";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

test("on the web it assigns location.href, does not call openUrl, and uses location.href as callbackURL", async () => {
  mocks.isTauri.mockReturnValue(false);
  const oauthUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=web";
  const location = { href: "http://localhost:1420/" };
  vi.stubGlobal("location", location);
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ url: oauthUrl, redirect: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await signInWithGoogle();

  expect(location.href).toBe(oauthUrl);
  expect(mocks.openUrl).not.toHaveBeenCalled();
  const [, init] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(init.body).callbackURL).toBe("http://localhost:1420/");
});

test("in Tauri it opens /api/auth-start in the system browser and does not fetch", async () => {
  mocks.isTauri.mockReturnValue(true);
  const location = { href: "http://localhost:1420/" };
  vi.stubGlobal("location", location);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await signInWithGoogle();

  expect(mocks.openUrl).toHaveBeenCalledWith(expect.stringMatching(/\/api\/auth-start$/));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(location.href).toBe("http://localhost:1420/");
});
