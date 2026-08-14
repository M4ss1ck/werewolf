import { Hono } from "hono";

import { serveClient } from "./static/serve-client.ts";

// One process serves the SPA, the HTTP API, Better Auth, the WebSocket
// endpoint, the scheduler and the game coordinator.
//
// Route modules mount themselves here as they land; this file owns only the
// composition order.
export function createApp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Must stay last: the SPA fallback swallows unmatched GETs.
  serveClient(app);

  return app;
}

export type App = ReturnType<typeof createApp>;
