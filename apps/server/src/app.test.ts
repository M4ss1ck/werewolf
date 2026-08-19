import { expect, test } from "bun:test";
import { createApp } from "./app.ts";

test("health reports ok", async () => {
  const response = await createApp().request("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("unmatched api routes 404 rather than falling through to the SPA", async () => {
  const response = await createApp().request("/api/does-not-exist");

  expect(response.status).toBe(404);
});

test("an OPTIONS preflight from a trusted origin is allowed with credentials", async () => {
  const app = createApp({ trustedOrigins: ["https://werewolf.example.com"] });
  const response = await app.request("/api/games", {
    method: "OPTIONS",
    headers: {
      origin: "https://werewolf.example.com",
      "access-control-request-method": "GET",
    },
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://werewolf.example.com");
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
});

test("a request from an untrusted origin does not get an allow-origin for it", async () => {
  const app = createApp({ trustedOrigins: ["https://werewolf.example.com"] });
  const response = await app.request("/api/games", {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example.com",
      "access-control-request-method": "GET",
    },
  });

  expect(response.headers.get("access-control-allow-origin")).not.toBe("https://evil.example.com");
});

test("an empty trusted list emits no CORS headers", async () => {
  const app = createApp({ trustedOrigins: [] });
  const response = await app.request("/api/games", {
    method: "OPTIONS",
    headers: {
      origin: "https://werewolf.example.com",
      "access-control-request-method": "GET",
    },
  });

  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

// A WebSocket upgrade is not subject to CORS and the browser attaches cookies to
// it anyway, so a cross-site deployment (SameSite=None) must reject a handshake
// from an origin it does not trust — otherwise a hostile page reads the victim's
// own viewer projection, which carries their secret role.
const liveApp = () =>
  createApp({
    trustedOrigins: ["https://werewolf.example.com"],
    coordinator: {} as never,
    sessionResolver: async () => ({ userId: "u-1", username: "u" }),
    gameHub: {} as never,
  });

test("a live socket upgrade from an untrusted origin is refused", async () => {
  const response = await liveApp().request("/api/games/g-1/live", {
    headers: { origin: "https://evil.example.com" },
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "ORIGIN_NOT_ALLOWED" } });
});

test("a live socket upgrade with no origin at all is refused", async () => {
  const response = await liveApp().request("/api/games/g-1/live");

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "ORIGIN_NOT_ALLOWED" } });
});

test("a live socket upgrade from a trusted origin passes the origin guard", async () => {
  // A stub Bun server so the handshake declines cleanly instead of throwing;
  // what matters is that the guard let it through to the upgrade at all.
  const response = await liveApp().request(
    "/api/games/g-1/live",
    { headers: { origin: "https://werewolf.example.com" } },
    { server: { upgrade: () => false } },
  );

  expect(response.status).not.toBe(403);
});
