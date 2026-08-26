# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-08-25

### Added
- Add shareable invitation experience with persistent invitations and membership access
- Add game entry and invitation routes with protocol contracts
- Add localized private game labels on active and finished game cards
- Show participant private games under All while keeping anonymous browsing public
- Show the pack's night ballot to living pack members for coordinated wolf attacks
- Name who else is in the secret channel above the wolves and cult chat lists
- Seat a bot in the lobby immediately before the server responds, with optimistic UI updates
- Sign in as a seeded dev user on localhost instances for browser verification
- Load the Telegram SDK only inside a Mini App to avoid console noise and third-party requests
- Toast transient chat failures at the bottom of the screen instead of pinning them by the input

### Changed
- Pace bot chat by room size with a slot queue per game and channel, replacing uniform random delays
- Build bot prompts after winning a slot so they answer what was said during the wait
- Let bots hold conversations in secret channels at night, including mentions arriving mid-decision
- Finish off losers and end decided games with role-based outcome declarations
- Mark dead players and winners in revealed roles with skull and W ribbon overlays
- Remove brackets from private game labels and align private badge assertions with copy
- Derive replay timeline day from phase id instead of the final game day
- Filter replay timeline to public chat messages only, dropping undescribable rows
- Accept stale phase ids for chat sends while still rejecting phase-scoped intents
- Stop the web build from using a bearer WebSocket subprotocol, gating it to Tauri and Telegram runtimes
- Re-read the route when the popstate listener attaches and bail out when the URL has not moved
- Update dependencies: better-auth 1.7 with account issuer migration, drizzle-orm 0.45, TypeScript 7, vite 8, vitest 4, i18next 26, and minor patch sweeps
- Pin Bun to 1.4.x in Docker and CI for consistent runtime behavior
- Install dev dependencies at boot from named volumes with the lockfile as the only authority
- Keep each workspace's node_modules in the dev stack with proper volume mounts
- Install only runtime dependencies in the final Docker image
- Catch Telegram polling failures instead of crashing the server
- Accept the error code hosted Turso reports for a duplicate column
- Avoid duplicated victory verb in i18n strings

### Fixed
- Enforce game membership authorization on the server
- Stop caret restore from re-selecting a trailing mention in the client
- Remove brackets from private game label in the client
- Load the Telegram SDK only inside a Mini App, avoiding console noise and third-party requests
- Stop rejecting chat on a stale phase id, preventing silent message loss
- Stop the web build from using a bearer WebSocket subprotocol, fixing dead sockets in production
- Keep the route object when the URL has not moved, preventing duplicate game loads
- Re-read the route when the popstate listener attaches, fixing navigation state desync
- Drop undescribable rows from the replay timeline and fix the day gutter stamping
- Fix the web build from using a bearer subprotocol, restoring game and chat sockets in production

## [0.1.8] - 2026-08-22

### Added
- Add a shared virtualized chat UI with retained global history and continuity across global and in-game chat
- Add structured chat mentions with candidate search, persistent metadata, and validation for known in-game mentions
- Add mention identity support to chat drafts
- Track persistent unread state
- Support structured chat mentions for bots
- Sign in from a Telegram Mini App through a polled claim

### Fixed
- Preserve exact viewport snapshots when restoring chat history
- Jump to the latest message when the first message arrives
- Correct bot chat integration and address remaining chat integration issues
- Keep long player names inside their row

## [0.1.7] - 2026-08-20

### Added
- Hand the desktop token back over a loopback redirect, replacing the unreliable custom deep link for browser-based sign-in
- Carry the app's locale through the authentication flow so users are answered in their chosen language mid-sign-in

### Changed
- Distinguish the five different failure modes that previously shared a single HANDOFF_FAILED code, making it clear whether a token was spent, a request never left the machine, or the server was unreachable
- Document the loopback handoff flow, including why a redirect works where a custom scheme could not and the security properties that keep it safe

### Fixed
- Resolve an issue where packaged clients could fail silently when built without a server origin, now refusing to build unless VITE_SERVER_ORIGIN is provided

## [0.1.6] - 2026-08-20

### Fixed
- Fixed a flaky game-over test by waiting for the live socket instead of reading it synchronously
- Raised the app window when a deep link arrives so sign-in completion is visible to the user
- Enabled logging in release builds so packaged artifacts can produce diagnostics
- Surfaced failed sign-in handoff codes on the sign-in screen instead of silently dropping them
- Prevented caching of app-handoff pages that embed one-time tokens
- Encoded the WebSocket bearer subprotocol as base64url to fix authentication for packaged clients
- Changed the browser-to-app handoff to require a user click rather than a server redirect

### Changed
- Release workflow now publishes only after all artifacts have uploaded, avoiding partial releases
- Release workflow fails early if the server origin is not configured, preventing unusable builds
- Updated documentation to describe the handoff as a click, not a redirect

## [0.1.5] - 2026-08-20

### Fixed
- Start packaged-app OAuth in the browser that finishes the authentication flow

## [0.1.4] - 2026-08-20

### Fixed
- Corrected Linux artifact layout so Arch packaging finds the expected target and icon paths

## [0.1.3] - 2026-08-20

### Fixed
- Ensure release commits include all workspace manifests for a complete version bump
- Add integration test coverage for the full release workflow

## [0.1.2] - 2026-08-20

### Fixed
- Prevent duplicate changelog entries when the previous release has no Git tag
- Normalize the AI provider URL for consistent behavior

## [0.1.1] - 2026-08-19

### Changed
- Prepare the first packaged release with synchronized version metadata and release automation

## [0.1.0] - 2026-08-19

### Added
- Add the Alpha Wolf, Cub, Cult, Detective, Lone Wolf, Sorcerer, Veteran, and Serial Killer roles
- Add the Priest and Guardian roles with a restructured night resolution
- Add the Mayor with day actions
- Add Cupid with player links
- Add the Drunk with a perceived role
- Add composition presets for quick game setup
- Add grave chat for dead players
- Add a stalemate draw to victory resolution
- End phases on completion, with the clock as a hard limit
- Add the core game loop: lobbies, scheduled start times, day voting, night actions, and a replay screen
- Add a seeded RNG and a balanced role composer
- Add viewer-specific snapshots that gate what each player can see
- Add authentication, the game coordinator, and the HTTP API
- Persist games, players, and events over libSQL
- Drive phases on a timer and push updates over WebSocket
- Add English and Spanish resources
- Add the lobby, game, and replay screens with a live connection and API client
- Rebuild the interface with a cold folk-horror design system
- Add a global chat tab with virtualized infinite history
- Add bot players: a roster with per-bot models and settings, seating from the lobby, and LLM-driven seats through the command path
- Give bots bounded conversation context and let them answer chat during voting
- Add a player's lifetime record and endgame reveal with game summaries and stats
- Require a username and show it instead of the user id
- Let players rename themselves from the profile screen
- Add a way out of a game back to the games list
- Badge in-game tabs that have unseen activity
- Add Reticle in-app verification tooling to the client
- Add the werewolf logo across every platform

### Changed
- Role modules now declare their actions, composition metadata, chat channels, and pack membership, with the engine deriving legal commands and validation from those declarations
- Bound bot model concurrency and stop reading the whole match log
- Draw tab bar icons with lucide instead of CSS shapes
- Update bot models to deepseek-v4-flash

### Fixed
- Deal the Lone Wolf correctly
- Accept the serial killer's actions on the wire
- Give roster seats room for reasoning tokens and stop sending response_format to the bot provider
- Take each event id from its own insert
- Default the games filter to lobby
- Swap to game over when the match ends live
- Give each in-game tab its own scroll and footer
- Drop watch replay when already on the replay route
- Render every route in one 480px app column
- Show the error when a gameplay command is rejected
- Push a snapshot on lobby membership and meta changes
- Follow the game start live from the lobby and reflect a registered vote on the lock button
- Stop leaking the RNG seed and repair the replay endpoint
- Follow the Google OAuth redirect and trust the Vite origin in development
- Let signed-out visitors read the public game list
- Give the container a writable data dir and resolve client IPs
