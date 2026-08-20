import { afterEach, expect, test, vi } from "vitest";

import { listenForTelegramCallback, startTelegramHandoff, telegramWebApp } from "./telegram.ts";

const mocks = vi.hoisted(() => ({
  captureAuthToken: vi.fn(),
}));

vi.mock("./token.ts", () => ({ captureAuthToken: mocks.captureAuthToken }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
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
