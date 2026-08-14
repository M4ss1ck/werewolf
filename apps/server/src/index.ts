import { applyMigrations, createDb, GameRepository } from "@werewolf/db";
import { createApp } from "./app.ts";
import { createAuth, resolveAuthSession } from "./auth/auth.ts";
import { createAuthTables } from "./auth/schema.ts";
import { loadEnv } from "./env.ts";
import { GameCoordinator } from "./game/coordinator.ts";
import { PhaseScheduler } from "./game/scheduler.ts";
import { GameHub } from "./live/game-hub.ts";

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
const hub = new GameHub(coordinator);
const app = createApp({
  repository,
  coordinator,
  gameHub: hub,
  auth,
  sessionResolver: (request) => resolveAuthSession(auth, request),
});

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  websocket: { message() {} },
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
      client.close();
      process.exit(0);
    });
  });
}
