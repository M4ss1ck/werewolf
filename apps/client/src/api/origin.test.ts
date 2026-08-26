import { afterEach, describe, expect, test, vi } from "vitest";

import { apiUrl, invitationUrl, serverOrigin, wsUrl } from "./origin.ts";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.isTauri.mockReset();
});

describe("apiUrl", () => {
  test("an empty origin returns the path unchanged", () => {
    expect(apiUrl("/api/games", "")).toBe("/api/games");
  });

  test("a non-empty origin prefixes the path", () => {
    expect(apiUrl("/api/games", "https://werewolf.example.com")).toBe(
      "https://werewolf.example.com/api/games",
    );
  });

  test("a trailing slash on the origin does not produce a double slash", () => {
    expect(apiUrl("/api/games", "https://werewolf.example.com/")).toBe(
      "https://werewolf.example.com/api/games",
    );
  });
});

describe("share origins", () => {
  test("web links use the page origin even when an API origin is configured", () => {
    mocks.isTauri.mockReturnValue(false);
    vi.stubGlobal("window", { location: { origin: "https://play.example.com" } });
    expect(serverOrigin("https://api.example.com")).toBe("https://play.example.com");
    expect(invitationUrl("K7M3P9T2WQ", "https://api.example.com")).toBe(
      "https://play.example.com/join?code=K7M3P9T2WQ",
    );
  });

  test("packaged links use the configured HTTPS server origin", () => {
    mocks.isTauri.mockReturnValue(true);
    expect(invitationUrl("K7M3P9T2WQ", "https://play.example.com/")).toBe(
      "https://play.example.com/join?code=K7M3P9T2WQ",
    );
    expect(() => invitationUrl("K7M3P9T2WQ", "tauri://localhost")).toThrow("web server origin");
  });
});

describe("wsUrl", () => {
  test("an empty origin on an http page uses ws and the page host", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:1420" });
    expect(wsUrl("/api/games/g-1/live", "")).toBe("ws://localhost:1420/api/games/g-1/live");
  });

  test("an empty origin on an https page uses wss and the page host", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "werewolf.example.com" });
    expect(wsUrl("/api/games/g-1/live", "")).toBe("wss://werewolf.example.com/api/games/g-1/live");
  });

  test("a non-empty http origin maps to ws", () => {
    expect(wsUrl("/api/chat/live", "http://werewolf.example.com")).toBe(
      "ws://werewolf.example.com/api/chat/live",
    );
  });

  test("a non-empty https origin maps to wss", () => {
    expect(wsUrl("/api/chat/live", "https://werewolf.example.com")).toBe(
      "wss://werewolf.example.com/api/chat/live",
    );
  });

  test("a trailing slash on the origin does not produce a double slash", () => {
    expect(wsUrl("/api/chat/live", "https://werewolf.example.com/")).toBe(
      "wss://werewolf.example.com/api/chat/live",
    );
  });
});
