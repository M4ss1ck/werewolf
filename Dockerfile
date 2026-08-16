# One production app container. It serves the React SPA, the HTTP API, Better
# Auth, the WebSocket endpoint, the scheduler and the game coordinator.
# Deployment builds from this file, not from Nixpacks.

FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# --- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/
RUN bun install --frozen-lockfile

# --- client build -----------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/client apps/client
RUN bun run --cwd apps/client build

# --- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules node_modules
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
