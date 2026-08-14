import type { GameRepository } from "@werewolf/db";
import { Hono } from "hono";
import {
  type createAuth,
  requireViewer,
  sessionMiddleware,
  type ViewerContext,
} from "./auth/auth.ts";
import { GameCoordinator } from "./game/coordinator.ts";
import { commandRoutes } from "./routes/commands.ts";
import { eventRoutes } from "./routes/events.ts";
import { gamesRoutes } from "./routes/games.ts";
import { preferenceRoutes } from "./routes/preferences.ts";
import { replayRoutes } from "./routes/replay.ts";

import { serveClient } from "./static/serve-client.ts";

// One process serves the SPA, the HTTP API, Better Auth, the WebSocket
// endpoint, the scheduler and the game coordinator.
//
// Route modules mount themselves here as they land; this file owns only the
// composition order.
export type AppOptions = {
  repository?: GameRepository;
  sessionResolver?: (request: Request) => Promise<ViewerContext | null>;
  coordinator?: GameCoordinator;
  auth?: ReturnType<typeof createAuth>;
};

export function createApp(options: AppOptions = {}) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  if (options.auth) app.on(["GET", "POST"], "/api/auth/*", (c) => options.auth!.handler(c.req.raw));

  if (options.repository || options.coordinator) {
    const coordinator = options.coordinator ?? new GameCoordinator(options.repository!);
    app.use("/api/*", sessionMiddleware(options.sessionResolver ?? (async () => null)));
    app.use("/api/*", requireViewer);
    app.route("/api/games", gamesRoutes(coordinator));
    app.route("/api", commandRoutes(coordinator));
    app.route("/api", eventRoutes(coordinator));
    app.route("/api", replayRoutes(coordinator));
    app.route("/api", preferenceRoutes());
  }

  // Must stay last: the SPA fallback swallows unmatched GETs.
  serveClient(app);

  return app;
}

export type App = ReturnType<typeof createApp>;
