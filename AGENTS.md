# Working rules

Read `README.md` first for the layout and commands. This file is about how to
write code here.

## The gate

Nothing is done until this passes:

```bash
bun run format     # Biome: format, organize imports, apply safe lint fixes
bun run check      # lint + boundaries + typecheck (6 workspaces) + bun test + vitest
```

Run `bun run format` before `bun run check`; the gate fails on unformatted code.
Run the gate before claiming any task is complete. If you touched the client, also run
`bun run build`. Never report success on a command you did not actually run, and
never paste output you did not actually see.

`bun test <dir>` exits 0 when the filter matches no files. When you name a test
command, name a concrete path so an empty run cannot pass silently.

## How to write code

**Test first.** Write a failing test, watch it fail for the reason you expect,
then make it pass. This matters most in `game-engine`, where the rules are
fiddly and a wrong resolution order is invisible until a real game breaks. Table
-driven tests are the right shape for role interactions.

**YAGNI.** Write the minimum that solves the problem in front of you. No config
knobs, extension points, abstractions for single-use code, or error handling for
impossible states. If 200 lines could be 50, write the 50.

**Small, human-readable logic.** Short functions that do one thing, named after
the domain (`resolveWolfBallot`, not `processStage3`). Prefer a plain `if` chain
a reader can follow over a clever lookup table. Someone debugging a live game at
2am should be able to read the resolution path top to bottom.

**Surgical changes.** Touch only what the task requires. Don't reformat, rename
or "improve" adjacent code. Match the surrounding style. If you notice unrelated
dead code, mention it rather than deleting it. Do clean up imports and helpers
that *your* change orphaned.

**Ask instead of guessing.** If a requirement is ambiguous or two readings would
produce materially different code, stop and ask. Don't silently pick one.

## Invariants

These are load-bearing. Breaking one is a bug even if tests pass.

**The server is the only authority.** Clients receive a viewer-specific
projection, never the full state. The client must never import `game-engine`;
`scripts/check-boundaries.ts` enforces this, so treat a failure there as a design
error, not a lint annoyance.

**The engine is pure.** `game-engine` depends only on `protocol`. No React,
Tauri, Hono, Drizzle, libSQL, Better Auth, WebSockets or i18n. No I/O, no clock
reads, no `Math.random`.

**Resolution is deterministic.** Same state + same frozen intents + same balance
version + same seed produces the same result, every time. Randomness comes from
the seeded RNG derived by semantic scope, so an unrelated new random call cannot
shift an existing outcome.

**Events are semantic, never prose.** The server stores and sends what happened
(`{ kind: "player.eliminated", payload: { playerId, role, cause } }`), not a
sentence. Errors are codes (`PHASE_CLOSED`), not messages. The client renders
both in English or Spanish.

**Machine identifiers are never translated.** Role ids, faction ids, action ids,
phases, event kinds, error codes and statuses are stable wire values.
Translation only affects presentation.

**Hidden information stays hidden.** Role composition, other players' roles,
individual votes during a match, wolf chat, and server audit events must never
reach a viewer projection. Wolf-chat history before a converted player's
conversion is not theirs to read. Treat these as security tests, not UI tests.

**The engine returns patches, not mutations.** Domain operations return explicit
state changes plus events; persistence applies them. Do not mutate state in
place and leave the storage layer to diff it.

**Every mutation goes through the per-game lock and the version fence.** The
in-memory lock is convenience; the `games.version` compare-and-set is the
durable guard. If the update affects zero rows, the transition is stale — abort,
don't retry blindly.

**Never broadcast before commit.** Persist first, then fan out.

**Commands are idempotent** via `command_id`. A retried chat message must not
produce two events.

## Design decisions already made

Don't relitigate these mid-task. If you believe one is wrong, say so explicitly
and wait — do not quietly implement something else.

- **Three game tables only:** `games`, `game_players`, `game_events`. Transient
  intents (votes, night actions) live in `phase_state_json` on the player row and
  simply go stale when the phase changes. No votes/actions/messages/jobs/locks
  tables. Auth tables belong to Better Auth.
- **Mutations over HTTP, realtime push over WebSocket.** Do not build gameplay
  RPC on the socket; it would complicate auth, retries, idempotency and errors
  for no gain.
- **Roles are modules with a fixed set of hooks.** A central resolver owns the
  execution order. Roles do not trigger each other recursively, and there is no
  role scripting DSL.
- **Phases end on the clock, not on completion.** A phase does not finish early
  because everyone acted, players may change their intent until the deadline, and
  missing a vote or action carries no penalty.
- **One replica.** The game hub, per-game locks and event fanout are in-process.
  Anything that assumes horizontal scaling is out of scope.
- **The scheduler is timers over authoritative DB columns.** `scheduled_at` and
  `phase_ends_at` are the truth; in-memory timers are an optimization, and
  startup must recover anything overdue.

## Out of scope

Do not add these opportunistically, even if they seem easy: dead-player chat,
mason chat, custom roles or compositions, mid-game replacement, friends, DMs,
matchmaking, rankings, achievements, push notifications, media attachments, a
full moderation system, Redis, multiple replicas, microservices, separate
frontend/scheduler/WebSocket containers, or a local DB container.

The architecture should stay *compatible* with later work on extra roles,
neutral factions and cross-process coordination. That is not permission to build
it now.

## Git

Commit whole, working changes. Don't commit planning documents, design notes or
implementation plans; they stay local. Don't commit unless asked.
