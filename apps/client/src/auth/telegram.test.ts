import { afterEach, expect, test, vi } from "vitest";

import { signInWithGoogle } from "./session.ts";
import {
  listenForTelegramCallback,
  loadTelegramSdk,
  startTelegramHandoff,
  telegramWebApp,
} from "./telegram.ts";

const mocks = vi.hoisted(() => ({
  captureAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
  getAuthToken: vi.fn(),
  isTauri: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("./token.ts", () => ({
  captureAuthToken: mocks.captureAuthToken,
  clearAuthToken: mocks.clearAuthToken,
  getAuthToken: mocks.getAuthToken,
}));

const SDK_SRC = "https://telegram.org/js/telegram-web-app.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  document.querySelector(`script[src="${SDK_SRC}"]`)?.remove();
});

test("telegramWebApp returns null when Telegram is absent", () => {
  expect(telegramWebApp()).toBeNull();
});

test("telegramWebApp returns null when initData is empty (an ordinary browser tab)", () => {
  vi.stubGlobal("Telegram", { WebApp: { initData: "", openLink: vi.fn() } });
  expect(telegramWebApp()).toBeNull();
});

test("telegramWebApp returns the WebApp when initData is present", () => {
  const webApp = { initData: "x", openLink: vi.fn() };
  vi.stubGlobal("Telegram", { WebApp: webApp });
  expect(telegramWebApp()).toBe(webApp);
});

test("startTelegramHandoff opens the browser leg and polls until ready, then exchanges the token", async () => {
  vi.useFakeTimers();
  const openLink = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { initData: "x", openLink } });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ready", ott: "t" }), { status: 200 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const onResult = vi.fn();
  listenForTelegramCallback(onResult);

  const promise = startTelegramHandoff("en");
  await vi.advanceTimersByTimeAsync(1500);
  await promise;

  expect(openLink).toHaveBeenCalledTimes(1);
  const url = openLink.mock.calls[0]![0] as string;
  expect(url).toContain("/api/auth-start?tg=");
  expect(url).toContain("locale=en");
  // pending, then ready, then the one-time-token verify POST.
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]![0]).toBe("/api/auth/one-time-token/verify");
  expect(onResult).toHaveBeenCalledWith({ ok: true });
});

test("startTelegramHandoff delivers an error code to the listener", async () => {
  vi.useFakeTimers();
  const openLink = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { initData: "x", openLink } });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "error", code: "HANDOFF_FAILED" }), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const onResult = vi.fn();
  listenForTelegramCallback(onResult);

  const promise = startTelegramHandoff("en");
  await promise;

  expect(onResult).toHaveBeenCalledWith({ ok: false, code: "HANDOFF_FAILED" });
});

test("startTelegramHandoff times out with HANDOFF_TIMEOUT when the claim never becomes ready", async () => {
  vi.useFakeTimers();
  const openLink = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { initData: "x", openLink } });
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ status: "pending" }), { status: 200 })),
    );
  vi.stubGlobal("fetch", fetchMock);
  const onResult = vi.fn();
  listenForTelegramCallback(onResult);

  const promise = startTelegramHandoff("en");
  await vi.advanceTimersByTimeAsync(300_000);
  await promise;

  expect(onResult).toHaveBeenCalledWith({ ok: false, code: "HANDOFF_TIMEOUT" });
});

test("on the plain web loadTelegramSdk injects nothing and sign-in takes the Google POST path", async () => {
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

  await loadTelegramSdk();
  expect(document.querySelectorAll(`script[src="${SDK_SRC}"]`)).toHaveLength(0);
  expect(telegramWebApp()).toBeNull();

  await signInWithGoogle();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/auth/sign-in/social");
  expect(init.method).toBe("POST");
  expect(location.href).toBe(oauthUrl);
});

test("in a Telegram webview the SDK script is injected once and the handoff starts", async () => {
  mocks.isTauri.mockReturnValue(false);
  const openLink = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { initData: "x", openLink } });
  vi.stubGlobal("location", { href: "http://localhost:1420/", hash: "#tgWebAppData=..." });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "error", code: "HANDOFF_FAILED" }), { status: 200 }),
      ),
  );
  vi.resetModules();

  const { loadTelegramSdk: loadFresh } = await import("./telegram.ts");
  const { signInWithGoogle: signInFresh } = await import("./session.ts");

  const first = loadFresh();
  const second = loadFresh();
  expect(first).toBe(second);

  const scripts = document.querySelectorAll(`script[src="${SDK_SRC}"]`);
  expect(scripts).toHaveLength(1);
  scripts[0]!.dispatchEvent(new Event("load"));

  await signInFresh();

  expect(openLink).toHaveBeenCalledTimes(1);
  const url = openLink.mock.calls[0]![0] as string;
  expect(url).toContain("/api/auth-start?tg=");
  expect(document.querySelectorAll(`script[src="${SDK_SRC}"]`)).toHaveLength(1);
});
