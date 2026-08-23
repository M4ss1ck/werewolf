import { afterEach, describe, expect, test, vi } from "vitest";

import {
  captureAuthToken,
  clearAuthToken,
  clearStoredTokenOnCookieRuntime,
  getAuthToken,
  setAuthToken,
} from "./token.ts";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.isTauri.mockReset();
  localStorage.clear();
});

describe("auth token storage", () => {
  test("set/get/clear round-trip", () => {
    mocks.isTauri.mockReturnValue(true);
    expect(getAuthToken()).toBeNull();
    setAuthToken("token-1");
    expect(getAuthToken()).toBe("token-1");
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  test("captureAuthToken stores the token from a set-auth-token response header", () => {
    mocks.isTauri.mockReturnValue(true);
    const response = new Response(null, { headers: { "set-auth-token": "token-2" } });

    captureAuthToken(response);

    expect(getAuthToken()).toBe("token-2");
  });

  test("captureAuthToken without the header leaves the stored token untouched", () => {
    mocks.isTauri.mockReturnValue(true);
    setAuthToken("token-3");
    const response = new Response(null, { headers: { "content-type": "application/json" } });

    captureAuthToken(response);

    expect(getAuthToken()).toBe("token-3");
  });

  test("a throwing localStorage degrades to null / no-op instead of propagating", () => {
    mocks.isTauri.mockReturnValue(true);
    const throwingStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    };
    vi.stubGlobal("localStorage", throwingStorage);

    expect(getAuthToken()).toBeNull();
    expect(() => setAuthToken("token-4")).not.toThrow();
    expect(() => clearAuthToken()).not.toThrow();
    expect(() =>
      captureAuthToken(new Response(null, { headers: { "set-auth-token": "token-4" } })),
    ).not.toThrow();
  });
});

describe("runtime-gated auth token storage", () => {
  test("on the web, setAuthToken stores nothing and getAuthToken is null", () => {
    mocks.isTauri.mockReturnValue(false);
    setAuthToken("token-web");
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem("werewolf.auth-token")).toBeNull();
  });

  test("clearStoredTokenOnCookieRuntime removes a pre-existing key on a web runtime", () => {
    mocks.isTauri.mockReturnValue(true);
    setAuthToken("token-stale");
    expect(getAuthToken()).toBe("token-stale");

    mocks.isTauri.mockReturnValue(false);
    clearStoredTokenOnCookieRuntime();
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem("werewolf.auth-token")).toBeNull();
  });

  test("clearStoredTokenOnCookieRuntime leaves the key in place on a Tauri runtime", () => {
    mocks.isTauri.mockReturnValue(true);
    setAuthToken("token-keep");
    clearStoredTokenOnCookieRuntime();
    expect(getAuthToken()).toBe("token-keep");
  });
});
