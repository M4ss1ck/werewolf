import { expect, test } from "bun:test";
import { allowedOrigins, PACKAGED_APP_ORIGINS } from "./origins.ts";

test("the packaged clients are trusted without any configuration", () => {
  const origins = allowedOrigins("https://werewolf.example.com", []);

  for (const packaged of PACKAGED_APP_ORIGINS) expect(origins).toContain(packaged);
});

test("the server's own origin is included, so a same-origin deployment keeps working", () => {
  // Without this the list is non-empty (the packaged origins are always there),
  // which turns on CORS and the socket guard — and the deployment's own pages
  // would then be refused by the guard they just enabled.
  const origins = allowedOrigins("https://werewolf.example.com/", []);

  expect(origins).toContain("https://werewolf.example.com");
});

test("configured origins are kept alongside the constants", () => {
  const origins = allowedOrigins("http://localhost:3000", ["http://localhost:1420"]);

  expect(origins).toContain("http://localhost:1420");
  expect(origins).toContain("http://localhost:3000");
  expect(origins).toContain("tauri://localhost");
});

test("duplicates collapse", () => {
  const origins = allowedOrigins("http://localhost:3000", [
    "http://localhost:3000",
    "tauri://localhost",
  ]);

  expect(origins).toEqual([...new Set(origins)]);
});

test("a malformed auth url still yields the packaged origins rather than throwing", () => {
  const origins = allowedOrigins("not a url", ["http://localhost:1420"]);

  expect(origins).toContain("http://localhost:1420");
  expect(origins).toContain("tauri://localhost");
});
