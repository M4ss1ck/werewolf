# Werewolf

Server-authoritative live social-deduction game. Web, Windows, Linux and Android
from one React + TypeScript client and one Bun + Hono backend.

The server owns all hidden state. Clients never receive the complete game state,
only a viewer-specific projection of it.

## Layout

```text
apps/
  client/            React + Vite + Tailwind v4 SPA
    src-tauri/       Tauri v2 desktop shell (Windows/Linux; Android added later)
  server/            Bun + Hono: API, Better Auth, WebSocket, scheduler, SPA host
packages/
  protocol/          Shared wire vocabulary (types + Zod schemas). No internal deps.
  game-engine/       Pure domain engine. Depends only on protocol.
  db/                Drizzle + Turso/libSQL. Depends on protocol + game-engine.
  i18n/              EN/ES resources and i18next factory. Depends on protocol.
scripts/
  check-boundaries.ts
```

Do not add `shared`, `common` or `utils` packages. A new package needs a real
reusable boundary behind it.

## Commands

```bash
bun install

bun run dev:server        # Bun + Hono on :3000
bun run dev:client        # Vite on :1420, proxying /api to :3000

bun run check             # lint + boundaries + typecheck + tests — the gate
bun run format            # Biome: format, organize imports, safe lint fixes
bun run lint              # Biome check without writing
bun run check:boundaries  # dependency rules
bun run typecheck         # tsc --noEmit in every workspace
bun run test              # bun test (packages, server) + vitest (client)
bun run build             # client production build

bun run --cwd apps/client tauri dev
bun run --cwd apps/client tauri build
```

Copy `.env.example` to `.env` before running the server.

## Package boundaries

`scripts/check-boundaries.ts` enforces these mechanically, not by convention:

| Package | May import |
|---|---|
| `protocol` | — |
| `game-engine` | `protocol` |
| `db` | `protocol`, `game-engine` |
| `i18n` | `protocol` |
| `server` | `protocol`, `game-engine`, `db` |
| `client` | `protocol`, `i18n` |

**The client must never import `game-engine`.** The client is not authoritative,
and giving it the engine would put hidden-state logic in reach of the player.

The same script keeps `game-engine` free of React, Tauri, Hono, libSQL, Drizzle,
Better Auth, WebSockets and i18n, so the domain stays testable in isolation.

Imports are scanned with `Bun.Transpiler`, so side-effect and dynamic imports
are caught too.

## Conventions

- Packages are consumed as TypeScript source (`exports: "./src/index.ts"`). There
  is no per-package build step; Bun and Vite compile them directly.
- Relative imports carry the `.ts`/`.tsx` extension (`allowImportingTsExtensions`).
- TypeScript is strict, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- Tests are colocated: `*.test.ts` next to the code. `bun test` for
  `packages/*` and `apps/server`, Vitest + Testing Library for `apps/client`.
- The server never emits localized prose. It emits semantic event kinds and
  machine-readable error codes; the client translates them.
- Machine identifiers (`RoleId`, `FactionId`, `ActionId`, `GamePhase`, event
  kinds, error codes, statuses) are never translated. Translation only affects
  presentation.

Note: `bun test <dir>` exits 0 when a filter matches no test files. Acceptance
commands should name a concrete test path so an empty run cannot pass silently.

## Deployment

One container, one replica, built from the committed `Dockerfile` and
`docker-compose.yml`. No Nixpacks, no Redis, no local DB container, no sidecars.
The single replica is a hard constraint while the game hub, the per-game locks
and event fanout live in-process.
