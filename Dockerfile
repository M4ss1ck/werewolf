# One production app container. It serves the React SPA, the HTTP API, Better
# Auth, the WebSocket endpoint, the scheduler and the game coordinator.
# Deployment builds from this file, not from Nixpacks.

FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# --- dependencies -----------------------------------------------------------
FROM base AS manifests
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/

# Everything, including the client toolchain the build stage needs.
FROM manifests AS deps
RUN bun install --frozen-lockfile

# Runtime dependencies only. apps/server has no devDependencies at all, so
# vite, vitest, tailwindcss, @tauri-apps/cli, testing-library, jsdom,
# typescript and biome were all shipping in the deployed image for nothing —
# 215MB of it. --production still writes the per-workspace links the runtime
# stage depends on, so @werewolf/* resolves exactly as before.
FROM manifests AS prod-deps
RUN bun install --frozen-lockfile --production

# --- client build -----------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/client apps/client
RUN bun run --cwd apps/client build

# --- runtime ----------------------------------------------------------------
# Built FROM prod-deps, not from base, and that is load-bearing. Bun installs a
# workspace's links into that workspace's own node_modules (apps/server/
# node_modules, packages/db/node_modules, ...), not into the root one. Copying
# only the root node_modules and then laying the sources on top left no way to
# resolve @werewolf/*, and the server died on boot with "Cannot find module
# '@werewolf/db'". Starting from prod-deps keeps every one of those directories,
# and the COPYs below merge the sources over them rather than replacing them.
FROM prod-deps AS runtime
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json bun.lock tsconfig.base.json ./
# The bot roster is resolved relative to the repo root, so it must ship too.
COPY bots.json ./
COPY apps/client/package.json apps/client/
COPY packages packages
COPY apps/server apps/server

# The SPA is served from apps/server/public (see src/static/serve-client.ts).
COPY --from=build /app/apps/client/dist apps/server/public

# Production points TURSO_DATABASE_URL at a hosted libsql:// URL and never
# touches this, but a file: URL must have somewhere writable to land or the
# container dies on boot with "Unable to open connection to local database".
RUN mkdir -p /app/data && chown -R bun:bun /app/data
VOLUME ["/app/data"]

USER bun

EXPOSE 3000

# Run exactly one replica: the game hub, the per-game locks and event fanout
# are all in-process.
CMD ["bun", "apps/server/src/index.ts"]
