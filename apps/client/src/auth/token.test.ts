import { afterEach, describe, expect, test, vi } from "vitest";

import { captureAuthToken, clearAuthToken, getAuthToken, setAuthToken } from "./token.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("auth token storage", () => {
  test("set/get/clear round-trip", () => {
    expect(getAuthToken()).toBeNull();
    setAuthToken("token-1");
    expect(getAuthToken()).toBe("token-1");
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  test("captureAuthToken stores the token from a set-auth-token response header", () => {
    const response = new Response(null, { headers: { "set-auth-token": "token-2" } });

    captureAuthToken(response);

    expect(getAuthToken()).toBe("token-2");
  });

  test("captureAuthToken without the header leaves the stored token untouched", () => {
    setAuthToken("token-3");
    const response = new Response(null, { headers: { "content-type": "application/json" } });

    captureAuthToken(response);

    expect(getAuthToken()).toBe("token-3");
  });

  test("a throwing localStorage degrades to null / no-op instead of propagating", () => {
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
