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

Adding a game role crosses `protocol`, `game-engine`, `i18n` and the client in a
fixed order: [docs/adding-a-role.md](docs/adding-a-role.md).

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

### The roster

Selectable bots are defined in `bots.json`, each with its own model and
settings, so one deployment can mix a cheap fast model across most seats with a
slower one on a couple:

```json
{ "id": "mira", "displayName": "Mira", "model": "deepseek-v4-flash",
  "temperature": 0.9, "maxOutputTokens": 180, "timeoutMs": 15000,
  "personality": "Blunt and impatient. Accuses early." }
```

Settings are frozen onto the seat when the bot is added, so editing the roster
cannot change a match already in progress. A built-in `random` entry ("Dummy")
is always present and needs no provider.

The host sees the roster in the lobby with per-entry availability
(`GET /api/games/:id/bots`) and seats one with
`POST /api/games/:id/bots {"botId": "mira"}`. An entry is unavailable when it
is `ALREADY_SEATED`, when the provider is not configured
(`PROVIDER_NOT_CONFIGURED`), or when the provider's `/models` listing does not
include its model (`MODEL_NOT_AVAILABLE`). The server rechecks this when
seating; the listing is advice to the client, not the rule.

### Running

```bash
bun run bots:match                        # 6 bots, unattended, no humans
bun run bots:match -- --players 8 --chat
bun run bots:match -- --random            # force every seat to the free bot
```

With no `BOT_AI_API_KEY` this costs nothing: only the random bot is selectable
and it picks a legal action via the seeded RNG. That is also the fallback for
every failure — provider timeout, network error, malformed JSON, schema
mismatch, or an action the model was never offered. It is not a strategy engine
and must not become one; the model is the brain.

### Scale and failure

Bots run in this process, and they cannot hold up a game:

- Phases end on the scheduler's clock, never on completion, so a dead provider
  costs a bot its turn and nothing else.
- The commit path never awaits a model call; decisions are fire-and-forget.
- Each call is bounded by that seat's `timeoutMs`, and answers arriving after
  the phase moved on are discarded before reaching the command path.
- `BOT_MAX_CONCURRENT_CALLS` caps calls in flight process-wide, so a room full
  of games queues instead of collecting rate limits.
- Prompts read a bounded window rather than the whole match: the recent event
  tail, the current phase's chat up to a cap, and a fixed-length digest of
  recent days. Cost per decision is bounded by those caps, not by match
  length, and `BOT_CHAT_TURNS` is the hard cap on model calls per bot per
  phase.

Provider configuration is environment-only and documented in `.env.example`.
Credentials are never written to a game row, projected to a viewer, or logged.

## Telegram bot

A Telegram bot runs inside the same server process, in long-polling mode — no
webhook and no extra container. It answers exactly three commands, registered
programmatically at boot (no BotFather setup): `/start` (a welcome message with
a "Play Werewolf" button), `/help` (lists the commands) and `/ping` (round-trip
latency to the Telegram API).

It is off unless `TELEGRAM_BOT_TOKEN` is set; without it the server boots
normally and simply does not start the bot. The `/start` WebApp button targets
`BETTER_AUTH_URL`, and Telegram only accepts an https URL there, so the button
is inert against the local `http://localhost:3000` default.

Because it polls `getUpdates`, exactly one replica may run it — a second one
would fight over the same updates. This reinforces the existing one-replica
rule.

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

The container reads its whole environment from `.env` via `env_file`, so a
variable added to `.env.example` needs no change here. That file must exist on
the host; copy `.env.example` and fill it in. Anything left out of it stays
*absent* rather than empty, which is what lets the code's own defaults apply —
listing variables explicitly instead would pass `""` for the unset ones, and an
empty string is not the same as unset to a schema with defaults.

## Releasing

Releases are cut locally with `scripts/release.sh`. The root `package.json` is
the single source of truth for the version; the script keeps every other version
file in sync so a Tauri build never rewrites `Cargo.lock` mid-CI.

```bash
# Preview what would happen (no changes made)
./scripts/release.sh 0.1.1 --dry-run

# Cut the release
./scripts/release.sh 0.1.1
```

What it does:

1. Ensures you are on a `release/v<version>` branch, creating it if needed.
2. Bumps the version via `scripts/bump-version.sh` across `package.json`,
   `apps/client/src-tauri/tauri.conf.json`, `apps/client/src-tauri/Cargo.toml`,
   the `app` entry in `apps/client/src-tauri/Cargo.lock`, and every workspace
   member under `apps/*` and `packages/*`. The workspace members are private and
   unpublished, so their version changes nothing at build time; they move so one
   release is one version across the repo rather than a release number on the
   client and a permanent `0.0.0` on the engine that built it.
3. Generates a `CHANGELOG.md` section for the commits since the last tag.
4. Commits the bump + changelog, creates the `v<version>` tag, and (after a
   confirmation) pushes the branch and the tag.

There is no git remote yet, so the push step is skipped with a warning and the
local commit and tag are left intact.

An Arch Linux package is also produced. It is built from the already-built Linux
binary rather than from source: `makepkg` runs inside an Arch container, so it
works from any distro and needs Docker locally. `bun run build:arch` does both
steps — the Tauri Linux build and the package.

### AI-assisted changelog (optional)

The changelog can be written by an AI model. This is entirely optional — with no
configuration the script falls back to a grouped list of commit messages and
never errors out. Configure it via a local `.env` file (git-ignored; copy
`.env.example` to get started). The release script reuses the existing bot
provider (`BOT_AI_BASE_URL` and `BOT_AI_API_KEY`); the only new variable is
`CHANGELOG_AI_MODEL`, the model id to use. Leave it empty to fall back to the
grouped commit list.

Use `--dry-run` to preview the generated changelog before committing anything.

## Authentication on packaged clients

The web build signs in with cookies and nothing below applies to it. The
packaged desktop and Android builds cannot use cookies at all: their webview is
cross-site to the server and never returns the session cookie, which was
confirmed by driving a real packaged Linux build against an instrumented server.
They authenticate with a bearer token instead.

Signing in cannot happen in the webview either — Google refuses OAuth inside an
embedded one — so it moves to the system browser and comes back through a deep
link:

1. The app asks the server for the Google URL and opens it in the **system
   browser**, passing `/api/auth-handoff` as the callback.
2. Google returns to the server, which establishes the session — as a cookie in
   that browser, where the app cannot reach it.
3. `/api/auth-handoff` mints a **one-time token** for that session and redirects
   to `werewolf://auth?ott=...`.
4. The OS hands the link to the running app, which exchanges the token at
   `/api/auth/one-time-token/verify` and keeps the `set-auth-token` it gets back.

From then on the token goes out as `Authorization: Bearer` on every request, and
as a `["bearer", token]` subprotocol on the live sockets, because a WebSocket
handshake cannot carry a header. It lives in `localStorage`, which — unlike the
cookie jar — survives an app restart.

One thing a deployment must get right, or the packaged apps fail:

- `VITE_SERVER_ORIGIN` must be set when building the packaged client, or the app
  has no server to reach. The release workflow passes it from a repository
  variable of the same name; a local build needs it in the environment. The web
  bundle wants it empty, because the server serves the SPA from its own origin.

You do **not** need to configure the packaged clients' origins. They are
constants of the client rather than of a deployment, so the server trusts them
unconditionally, along with its own origin
(`apps/server/src/auth/origins.ts`). `BETTER_AUTH_TRUSTED_ORIGINS` is only for
origins that genuinely vary per deployment, such as the Vite dev server or a web
frontend on its own domain.

The `werewolf://` scheme is declared in `tauri.conf.json` and must stay in step
with `APP_SCHEME` in `apps/server/src/routes/auth-handoff.ts`. On desktop the
single-instance plugin forwards the link to the app already running; without it
the OS starts a second copy and the window the user is looking at never sees the
session.

## Android

The Android build is a Tauri target, driven by three package scripts:

```bash
bun run android:init   # (re)generate the Gradle project under apps/client/src-tauri/gen/android
bun run android:dev    # run the app on a connected device/emulator
bun run build:android  # build and sign the release APKs
```

The Gradle project under `apps/client/src-tauri/gen/android` is committed on
purpose: CI cannot build an APK without it. `gen/schemas` stays ignored — it is
regenerated on every build.

`build:android` produces two per-ABI signed APKs (`arm64-v8a` and `x86_64`)
rather than one universal APK, roughly halving the download. Each APK carries
only its own native libraries, and the script verifies that with `aapt` so a
build can never ship extra libs.

The first local run generates a keystore under
`~/.config/werewolf/android-signing`. Back it up — losing it means never being
able to update the app under the same identity. CI needs the three
`ANDROID_*` secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`) to restore that same signing material. `ANDROID_KEY_ALIAS`
must be exactly `werewolf`: the script refuses credentials naming another alias,
so that a mismatched key can never silently sign a release.

`VITE_SERVER_ORIGIN` must be set at build time or the APK has no server to
reach: the client reads it at build time to know where the server is, and a
packaged app has no origin of its own. The script warns rather than fails, so a
throwaway local build still works. In CI it comes from the `VITE_SERVER_ORIGIN`
repository variable. The server must also list the app's origin in
`BETTER_AUTH_TRUSTED_ORIGINS`, which gates both CORS and the WebSocket
handshake.
