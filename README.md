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

## Getting started

```bash
cp .env.example .env      # then fill it in; every value is documented in the file
```

`.env.example` explains where each variable comes from, including how to get
Google OAuth credentials and a Turso database. For local development you need
neither: the default `TURSO_DATABASE_URL` is a local file, and only Google
sign-in requires real credentials.

### With Docker (development)

```bash
docker compose -f docker-compose.dev.yml up
```

Open **http://localhost:1420** — that is the Vite dev server, which hot-reloads
and proxies `/api` to the API on port 3000. Sources are bind-mounted, so edits
on the host reload in the container. The database is a file under `./data`, so
it survives restarts and needs no Turso account.

Dependencies live in the image, not in the bind mount — `/app/node_modules` is an
anonymous volume filled by `bun install` when the image was built. Installing a
package on the host therefore does not reach the container. After any change to a
`package.json`, rebuild and replace that volume:

```bash
docker compose -f docker-compose.dev.yml up --build --renew-anon-volumes
```

`--build` on its own is not enough: anonymous volumes survive container
recreation, so the stale `node_modules` comes back and Vite fails with `Failed to
resolve import`. The healthcheck only probes the API, so the container still
reports healthy while the client is broken.

`docker-compose.yml` (no `.dev`) is the production stack instead: one container
serving the built SPA and the API together.

### Without Docker

```bash
bun install
bun run dev               # server on :3000 and client on :1420 together
```

## Commands

```bash
bun run dev               # server + client
bun run dev:server        # Bun + Hono on :3000
bun run dev:client        # Vite on :1420, proxying /api to :3000

bun run check             # lint + boundaries + typecheck + tests — the gate
bun run format            # Biome: format, organize imports, safe lint fixes
bun run lint              # Biome check without writing
bun run check:boundaries  # dependency rules
bun run db:migrate       # create/migrate the database (game + Better Auth tables)
bun run typecheck         # tsc --noEmit in every workspace
bun run test              # bun test (packages, server) + vitest (client)
bun run build             # client production build

bun run --cwd apps/client tauri dev
bun run --cwd apps/client tauri build
```

Copy `.env.example` to `.env` before running the server.

## Database bootstrap

A fresh empty database is brought to a working state with one command:

```bash
bun run db:migrate
```

This applies the game-table migrations (`packages/db/src/migrations`) and then
creates Better Auth's own tables (`user`, `session`, `account`, `verification`
— they live in `apps/server/src/auth/schema.ts`, not in `@werewolf/db`). Both
steps are idempotent, and the server also runs them on every boot
(`apps/server/src/index.ts`), so the container self-provisions on a fresh
database — `bun run db:migrate` is only needed when you want to migrate
without starting the server.

## Bots

Any lobby seat can be driven by an LLM instead of a person. A bot is an
ordinary player row carrying a `controller`, and it submits its moves through
`coordinator.executeCommand` — the same call the HTTP command route makes for a
human — so validation, the per-game lock, the version fence and command
idempotency all apply to it unchanged. Bots are **not** WebSocket clients and
have no privileged path into the engine.

What the model sees is `projectSnapshot(state, botId)`, the same viewer
projection a human in that seat would receive, plus that viewer's visible
events. The omniscient `GameState` never reaches a prompt.

**Adding bots.** The host presses *Add bot* in the lobby, or calls the endpoint
directly:

```bash
curl -X POST /api/games/<id>/bots -d '{"count": 4}'
```

Host only, lobby or scheduled games only. Every field is optional
(`displayName`, `count`, `config`), so an empty body seats one usable bot.

**A whole match with no humans**, against a throwaway database:

```bash
bun run bots:match                 # 6 bots
bun run bots:match -- --players 8 --chat
```

With no `BOT_AI_API_KEY` this costs nothing: bots pick a random legal action
via the seeded RNG. That is the deliberate fallback for every failure — no key,
provider timeout, network error, malformed JSON, schema mismatch, or an action
the model was never offered. It is not a strategy engine and must not become
one; the model is the brain.

Configuration is environment-only and documented in `.env.example`
(`BOT_AI_BASE_URL`, `BOT_AI_API_KEY`, `BOT_AI_MODEL`, and the delay, turn-budget
and history limits). Any OpenAI-compatible endpoint works. Credentials are
never written to a game row, never projected to a viewer and never logged.

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
