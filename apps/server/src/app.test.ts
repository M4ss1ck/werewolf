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
