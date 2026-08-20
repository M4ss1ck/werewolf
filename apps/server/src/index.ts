import { applyMigrations, createDb, GameRepository, GlobalChatRepository } from "@werewolf/db";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { createAuth, resolveAuthSession } from "./auth/auth.ts";
import { allowedOrigins } from "./auth/origins.ts";
import { createAuthTables } from "./auth/schema.ts";
import { LlmBotAgent } from "./bots/agent.ts";
import { loadBotConfig } from "./bots/config.ts";
import { consoleBotLogger } from "./bots/log.ts";
import { BotManager } from "./bots/manager.ts";
import { ModelCatalog } from "./bots/model-catalog.ts";
import { OpenAiCompatibleProvider } from "./bots/provider-openai.ts";
import { loadBotRoster } from "./bots/roster.ts";
import { loadEnv } from "./env.ts";
import { GameCoordinator } from "./game/coordinator.ts";
import { PhaseScheduler } from "./game/scheduler.ts";
import { GameHub } from "./live/game-hub.ts";
import { GlobalChatHub } from "./live/global-chat-hub.ts";

const env = loadEnv();
const { client, db } = createDb(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
// Bring a fresh database up to working state: game-table migrations first,
// then the Better Auth tables. Both are idempotent, so re-running on every
// boot is harmless (this is what makes the container self-provisioning).
await applyMigrations(db);
await createAuthTables(client);
const auth = createAuth(db, env);
const repository = new GameRepository(db);
const coordinator = new GameCoordinator(repository);
const scheduler = new PhaseScheduler(repository, coordinator);
// Timers are an optimisation over the authoritative columns; re-arm this
// game's timer whenever the coordinator commits a change to it.
coordinator.onCommitted((gameId) => void scheduler.watch(gameId));
const hub = new GameHub(coordinator);
const chatRepository = new GlobalChatRepository(db);
const chatHub = new GlobalChatHub(chatRepository);
// Bots are in-process: model calls are plain async fetches that the commit
// path never awaits, and phases end on the scheduler's clock, so a slow or
// dead provider costs a bot its turn and nothing else.
const botConfig = loadBotConfig();
const botRoster = loadBotRoster(botConfig.BOT_ROSTER_PATH, consoleBotLogger);
const botCatalog = new ModelCatalog({
  baseUrl: botConfig.BOT_AI_BASE_URL,
  apiKey: botConfig.BOT_AI_API_KEY,
  logger: consoleBotLogger,
});
await botCatalog.probe();
const bots = new BotManager(coordinator, {
  agent: new LlmBotAgent(
    new OpenAiCompatibleProvider({
      baseUrl: botConfig.BOT_AI_BASE_URL,
      apiKey: botConfig.BOT_AI_API_KEY ?? "",
      name: botConfig.BOT_AI_PROVIDER,
    }),
    botConfig,
    consoleBotLogger,
  ),
  config: botConfig,
  logger: consoleBotLogger,
});
console.log(
  `bots: ${botRoster.length} in roster, provider ${botConfig.BOT_AI_PROVIDER}` +
    (botCatalog.configured ? "" : " (no API key: only the random bot is selectable)"),
);

const app = createApp({
  db,
  repository,
  coordinator,
  gameHub: hub,
  globalChat: { repository: chatRepository, hub: chatHub },
  bots: { roster: botRoster, catalog: botCatalog, config: botConfig },
  auth,
  sessionResolver: (request) => resolveAuthSession(auth, request),
  trustedOrigins: allowedOrigins(env.BETTER_AUTH_URL, env.BETTER_AUTH_TRUSTED_ORIGINS),
});

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  // Hono's own dispatcher: it routes open/close/message to the handlers
  // registered by upgradeWebSocket. A stub here silently drops every one.
  websocket,
});
await scheduler.start();

console.log(`werewolf server listening on ${server.url}`);

// Graceful restart: stop accepting new work, let the in-flight DB transaction
// finish, then exit. Scheduler and WebSocket shutdown hook in here once those
// modules exist.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop(false).then(() => {
      scheduler.stop();
      hub.stop();
      chatHub.stop();
      bots.stop();
      client.close();
      process.exit(0);
    });
  });
}
