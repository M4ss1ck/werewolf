import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const app = createApp();

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`werewolf server listening on ${server.url}`);

// Graceful restart: stop accepting new work, let the in-flight DB transaction
// finish, then exit. Scheduler and WebSocket shutdown hook in here once those
// modules exist.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop(false).then(() => process.exit(0));
  });
}
