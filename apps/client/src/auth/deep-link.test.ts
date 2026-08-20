import { afterEach, describe, expect, test, vi } from "vitest";

import { completeAuthFromUrl, listenForAuthDeepLinks } from "./deep-link.ts";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  openUrl: vi.fn(),
  onOpenUrl: vi.fn(),
  getCurrent: vi.fn(),
  captureAuthToken: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: mocks.onOpenUrl,
  getCurrent: mocks.getCurrent,
}));
vi.mock("./token.ts", () => ({ captureAuthToken: mocks.captureAuthToken }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("completeAuthFromUrl", () => {
  test("an ott URL posts to the verify endpoint and captures the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeAuthFromUrl("werewolf://auth?ott=abc123");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/one-time-token/verify");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(init.body)).toEqual({ token: "abc123" });
    expect(mocks.captureAuthToken).toHaveBeenCalledTimes(1);
  });

  test("an error URL returns that code without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeAuthFromUrl("werewolf://auth?error=UNAUTHENTICATED");

    expect(result).toEqual({ ok: false, code: "UNAUTHENTICATED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an unrelated URL returns IGNORED without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeAuthFromUrl("https://example.com/somewhere");

    expect(result).toEqual({ ok: false, code: "IGNORED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // These three used to share one HANDOFF_FAILED, which is why a failed
  // sign-in could not be told apart from a server that never answered.
  test("a rejected token says so, distinctly from a broken server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 400 })));

    const result = await completeAuthFromUrl("werewolf://auth?ott=abc123");

    expect(result).toEqual({ ok: false, code: "TOKEN_REJECTED" });
  });

  test("a 5xx is reported as the server failing, not the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const result = await completeAuthFromUrl("werewolf://auth?ott=abc123");

    expect(result).toEqual({ ok: false, code: "VERIFY_FAILED" });
  });

  test("a rejecting fetch is reported as unreachable rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await completeAuthFromUrl("werewolf://auth?ott=abc123");

    expect(result).toEqual({ ok: false, code: "VERIFY_UNREACHABLE" });
  });
});

describe("listenForAuthDeepLinks", () => {
  test("with isTauri() false it makes no Tauri calls and its return value is safely callable", async () => {
    mocks.isTauri.mockReturnValue(false);
    const onResult = vi.fn();

    const unsubscribe = listenForAuthDeepLinks(onResult);

    expect(mocks.onOpenUrl).not.toHaveBeenCalled();
    expect(mocks.getCurrent).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  test("with isTauri() true a URL from getCurrent() is handled, and the same URL again is not handled twice", async () => {
    mocks.isTauri.mockReturnValue(true);
    const url = "werewolf://auth?ott=abc123";
    mocks.getCurrent.mockResolvedValue([url]);
    mocks.onOpenUrl.mockResolvedValue(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onResult = vi.fn();

    const unsubscribe = listenForAuthDeepLinks(onResult);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith({ ok: true });

    // The same URL arriving again via the event must not be handled twice.
    const handler = mocks.onOpenUrl.mock.calls[0]![0] as (urls: string[]) => void;
    handler([url]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unsubscribe();
  });
});
