import type { GameRepository } from "@werewolf/db";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import {
  type createAuth,
  requireViewer,
  sessionMiddleware,
  type ViewerContext,
} from "./auth/auth.ts";
import { GameCoordinator } from "./game/coordinator.ts";
import type { GameHub } from "./live/game-hub.ts";
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
  gameHub?: GameHub;
};

export function createApp(options: AppOptions = {}) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  if (options.auth) app.on(["GET", "POST"], "/api/auth/*", (c) => options.auth!.handler(c.req.raw));

  if (options.repository || options.coordinator) {
    const coordinator = options.coordinator ?? new GameCoordinator(options.repository!);
    app.use("/api/*", sessionMiddleware(options.sessionResolver ?? (async () => null)));
    app.use("/api/*", (c, next) =>
      c.req.method === "GET" && c.req.path === "/api/games" ? next() : requireViewer(c, next),
    );
    app.route("/api/games", gamesRoutes(coordinator));
    app.route("/api", commandRoutes(coordinator));
    app.route("/api", eventRoutes(coordinator));
    app.route("/api", replayRoutes(coordinator));
    app.route("/api", preferenceRoutes());
    if (options.gameHub)
      app.get(
        "/api/games/:id/live",
        upgradeWebSocket((c) => {
          const viewer = c.get("viewer") as ViewerContext;
          let connection: ReturnType<GameHub["connect"]> | undefined;
          return {
            onOpen(_event, ws) {
              connection = options.gameHub!.connect(
                c.req.param("id") as import("@werewolf/protocol").GameId,
                viewer.userId as import("@werewolf/protocol").UserId,
                ws,
              );
            },
            onMessage(event) {
              if (connection) void connection.message(String(event.data));
            },
            onClose() {
              connection?.close();
            },
          };
        }),
      );
  }

  // Must stay last: the SPA fallback swallows unmatched GETs.
  serveClient(app);

  return app;
}

export type App = ReturnType<typeof createApp>;
