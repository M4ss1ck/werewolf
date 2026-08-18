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

**Delegate the typing.** Design decisions stay with you; mechanical implementation
goes to a cheap worker. Invoke the `delegate-implementation` skill before opening the
first file, and delegate unless the task is a genuine one-shot.

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

**One commit per logical change.** A commit is the unit a reviewer reads, so it
carries one idea: a single feature, a single fix, a single refactor. Don't let a
working tree accumulate several finished units of work and then land them as one
undifferentiated pile — split them, and keep a security or correctness fix in its
own commit rather than burying it inside a feature. Every commit must pass the
gate on its own, not merely at the end of the series.

For a task large enough to need several commits, work out the division before
starting, so the units land as they are finished instead of being reconstructed
afterwards. When a task is delegated, that division is the supervisor's job, not
the worker's: workers never commit.

<!-- reticle:begin (managed by `reticle init` — edit outside these markers) -->
## Verifying with Reticle

This app is instrumented by **Reticle**, an in-app verification layer exposed as `reticle_*` MCP tools and the `npx @reticlehq/server` CLI (always through npx: Reticle's server is not installed into this project). Verifying is part of "done", not an optional extra.

**Verify when you have changed something a user can see or do.** A component, a form, a route, a request, a piece of state that reaches the screen. Do it BEFORE telling the user it is complete. Reading the diff proves nothing and unit tests do not run the app.

**Do not reach for Reticle when the change cannot show up in the running app.** It costs tool calls and the user's patience, and a verdict over an unrelated flow proves nothing about what you changed. Skip it for: documentation, comments, tests, build config, CI, dependency bumps with no user-facing effect, backend or CLI work with no UI surface, and any change to a project that is not a running web app. Say in one line that you skipped verification and why, rather than silently not doing it.

**How to verify:**

- Drive the flow with `reticle_act_and_wait({ ref, action, until })`. It names the consequence you expect BEFORE the action, which is the difference between a check and a rationalisation.
- Batch a multi-step journey (a login, a form) into one `reticle_act_sequence` rather than one round trip per field.
- Read the surrounding evidence with `reticle_snapshot`, `reticle_state`, `reticle_network`, `reticle_console`.
- **Only `reticle_act_and_wait` and `reticle_assert` produce a verdict.** `reticle_act` and everything else move or read the app and prove nothing, so a session ending without one of those two has no result however many tools it used.
- Covered flows: `npx @reticlehq/server gate` reports which recorded flows the changed files affect and whether they still pass.

**Honesty, which is the whole point:**

- **`verified: "unknown"` is not a pass.** It means Reticle drove the app and could not tell what happened; `verifiedReason` says which clause decided that. Report it as unknown, never as working.
- **Never weaken a check to make it green.** Downgrading, skipping or deleting an assertion is a finding, not a fix.
- **If Reticle cannot run** (no daemon, or this is not a running web app), say so. Do not skip verification silently.
- **Setup is not finished until one real flow has been driven and produced a verdict.** `init` exiting 0, the tools appearing, and a session being listed are all things that happen before anything has been verified.

**Report Reticle's own defects with `reticle_feedback` the moment you notice**, then carry on with your task. You are the user Reticle is built for and the only one who can say what it cost you, and that knowledge is gone when your context is.

📄 **The rest is in [RETICLE.md](./RETICLE.md): what to do when the tools are missing, when a result carries `version_skew` or `update_available`, when `reticle_state` comes back empty, and how to write a feedback report that can be acted on. Read it when you hit one of those, not before.**
<!-- reticle:end -->
