import { type Db, GameRepository, type GlobalChatRepository } from "@werewolf/db";
import { Hono, type MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import {
  type createAuth,
  requireViewer,
  sessionMiddleware,
  type ViewerContext,
} from "./auth/auth.ts";
import { GameCoordinator } from "./game/coordinator.ts";
import type { GameHub } from "./live/game-hub.ts";
import type { GlobalChatHub } from "./live/global-chat-hub.ts";
import { authClaimRoutes, createHandoffClaims } from "./routes/auth-claim.ts";
import { authHandoffRoutes } from "./routes/auth-handoff.ts";
import { authStartRoutes } from "./routes/auth-start.ts";
import type { BotRoutesOptions } from "./routes/bots.ts";
import { botRoutes } from "./routes/bots.ts";
import { chatRoutes } from "./routes/chat.ts";
import { commandRoutes } from "./routes/commands.ts";
import { eventRoutes } from "./routes/events.ts";
import { gamesRoutes } from "./routes/games.ts";
import { meRoutes } from "./routes/me.ts";
import { preferenceRoutes } from "./routes/preferences.ts";
import { replayRoutes } from "./routes/replay.ts";

import { serveClient } from "./static/serve-client.ts";

// One process serves the SPA, the HTTP API, Better Auth, the WebSocket
// endpoint, the scheduler and the game coordinator.
//
// Route modules mount themselves here as they land; this file owns only the
// composition order.
export type AppOptions = {
  db?: Db;
  repository?: GameRepository;
  sessionResolver?: (request: Request) => Promise<ViewerContext | null>;
  coordinator?: GameCoordinator;
  auth?: ReturnType<typeof createAuth>;
  gameHub?: GameHub;
  globalChat?: { repository: GlobalChatRepository; hub: GlobalChatHub; now?: () => number };
  /** Present when this deployment seats bots; absent leaves the route off. */
  bots?: BotRoutesOptions;
  /** Browser origins allowed to call the API cross-site. Empty means
   * same-origin: no CORS is registered at all. */
  trustedOrigins?: string[];
};

export function createApp(options: AppOptions = {}) {
  const globalChatDb = options.db;
  if (options.globalChat && !globalChatDb) throw new Error("globalChat requires db");
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Cross-site deployments need CORS on the API. A same-origin deployment
  // (empty trustedOrigins) registers none and emits no CORS headers. Must be
  // registered before the auth handler and the other /api routes.
  if (options.trustedOrigins && options.trustedOrigins.length > 0) {
    app.use(
      "/api/*",
      cors({
        origin: options.trustedOrigins,
        credentials: true,
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["content-type", "authorization"],
        // The bearer plugin answers a session request with a `set-auth-token`
        // header carrying the client's token; expose it so the client can read it.
        exposeHeaders: ["set-auth-token"],
      }),
    );
  }

  // A WebSocket handshake is not subject to CORS, and the browser attaches
  // cookies to it regardless. A cross-site deployment needs SameSite=None, which
  // removes the only thing that was stopping a hostile page from opening an
  // authenticated socket and receiving the victim's own viewer projection — their
  // secret role. So gate the upgrade on Origin whenever trusted origins are
  // declared. A same-origin deployment declares none, keeps SameSite=Lax, and is
  // unaffected.
  const requireTrustedOrigin: MiddlewareHandler = async (c, next) => {
    const allowed = options.trustedOrigins ?? [];
    if (allowed.length === 0) return next();
    const origin = c.req.header("origin");
    if (!origin || !allowed.includes(origin))
      return c.json({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);
    await next();
  };

  if (options.auth) app.on(["GET", "POST"], "/api/auth/*", (c) => options.auth!.handler(c.req.raw));

  // The auth-handoff, auth-start and auth-claim routes must be mounted here,
  // BEFORE the block below: the later block runs every /api/* request through
  // sessionMiddleware and requireViewer, and requireViewer would answer these
  // routes with a 401 JSON body instead of letting them complete the browser-to-app
  // handoff. auth-claim in particular is polled by a Telegram Mini App that has
  // no session yet, so it must never be gated behind requireViewer.
  const handoffClaims = createHandoffClaims();
  if (options.auth) app.route("/api", authHandoffRoutes(options.auth, handoffClaims));
  if (options.auth) app.route("/api", authStartRoutes(options.auth, handoffClaims));
  app.route("/api", authClaimRoutes(handoffClaims));

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
    if (options.bots) app.route("/api", botRoutes(coordinator, options.bots));
    if (options.db) {
      // The stats route reads the repository; tests may hand in only a
      // coordinator, so fall back to a fresh repository over the same db.
      const repository = options.repository ?? new GameRepository(options.db);
      app.route("/api", meRoutes(options.db, repository));
    }
    if (options.gameHub)
      app.get(
        "/api/games/:id/live",
        requireTrustedOrigin,
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
    if (options.globalChat) {
      const { repository, hub, now } = options.globalChat;
      if (!globalChatDb) throw new Error("globalChat requires db");
      app.route("/api", chatRoutes(globalChatDb, repository, hub, now));
      app.get(
        "/api/chat/live",
        requireTrustedOrigin,
        upgradeWebSocket((c) => {
          const viewer = c.get("viewer") as ViewerContext;
          let connection: ReturnType<GlobalChatHub["connect"]> | undefined;
          return {
            onOpen(_event, ws) {
              connection = hub.connect(
                {
                  userId: viewer.userId as import("@werewolf/protocol").UserId,
                  displayName: viewer.username ?? viewer.userId,
                },
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
  }

  // Must stay last: the SPA fallback swallows unmatched GETs.
  serveClient(app);

  return app;
}

export type App = ReturnType<typeof createApp>;
