# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-19

### Added
- a bot surface with /start, /help and /ping
- trust the packaged clients without configuration
- sign in through the system browser on packaged clients
- hand a packaged app its own credential after browser sign-in
- authenticate with a bearer token when one is stored
- accept a session token as a bearer credential
- bump every workspace version, not just the client
- Arch Linux package
- signed per-ABI APK builds
- reach the server from a packaged app
- version sync, changelog and release script
- werewolf logo across every platform
- give bots bounded conversation context
- add composition presets
- add the Lone Wolf
- add the Cult
- add the Detective
- add the Sorcerer
- add the Cub
- restructure night resolution and add Priest and Guardian
- add player links and Cupid
- add day actions and the Mayor
- generalise the faction channel and add grave chat
- add the perceived role and the Drunk
- end phases on completion, with the clock as a hard limit
- rewrite victory resolution and add a stalemate draw
- add the alpha wolf
- add Reticle in-app verification tooling
- add veteran and serial killer roles
- let bots answer chat during voting
- badge in-game tabs that have unseen activity
- define bots as a roster with per-bot models and settings
- let the host seat bots from the lobby
- drive bot seats with an LLM through the command path
- model bot-controlled seats
- add a global chat tab with virtualized infinite history
- serve global chat over HTTP and a dedicated socket
- add global chat messages with capped retention
- add a way out of a game back to the games list
- let players rename themselves from the profile screen
- rebuild the in-game screens and end the migration
- add a compact seconds unit
- rebuild the out-of-game screens for mobile
- adopt the cold folk-horror design system
- add the mobile redesign copy in English and Spanish
- report a player's lifetime record
- describe game summaries, player stats and the endgame reveal
- require a username and show it instead of the user id
- pick a start time from presets and actually fire it
- rebuild the werewolf interface
- add the lobby, game and replay screens
- add the API client, live connection and i18n wiring
- add English and Spanish resources
- drive phases on a timer and push updates over WebSocket
- add auth, the game coordinator and the HTTP API
- persist games, players and events over libSQL
- project viewer snapshots and gate event visibility
- start games and drive the phase cycle
- resolve the night
- accept and store night action intents
- add state, roles, command validation and day voting
- add seeded RNG and the balanced role composer
- define the shared wire vocabulary

### Changed
- drop the unread emitsResult from ActionSpec
- split night resolution into named stages
- genericise night intent freezing and locations
- derive chat channels and pack membership from role modules
- derive legal commands from action specs
- derive command validation from action specs
- declare role actions on role modules
- declare role composition metadata on role modules
- rename cursed.converted to player.converted
- gate wolf chat on a role set
- bound model concurrency and stop reading the whole match log
- extract ChatBubble and ChatComposer from the Talk tab
- draw tab bar icons with lucide instead of CSS shapes

### Fixed
- run workspace tests sequentially
- keep the workspace links the server resolves through
- read the whole environment from .env
- actually deliver the settings that were only documented
- deliver the deep link to the running app, not a new one
- size the window to the app's portrait column
- point repository metadata at the real GitHub URL
- install as werewolf rather than app
- deal the Lone Wolf
- accept the serial killer's actions on the wire
- pin the rng seed in tests that need a wolf
- give roster seats room for reasoning tokens
- stop sending response_format to the bot provider
- take each event id from its own insert
- default games filter to lobby
- swap to game over when the match ends live
- give each in-game tab its own scroll and footer
- drop watch replay when already on the replay route
- render every route in one 480px app column
- show the error when a gameplay command is rejected
- push a snapshot on lobby membership and meta changes
- follow the game start live from the lobby
- reflect a registered vote on the lock button
- pin the in-game footer and scroll screen content internally
- push a fresh viewer snapshot on every committed transition
- re-read the bot roster after any lobby change
- resolve the roster from the repo root, not the working directory
- run the Vite dev server under node
- dispatch websocket events to Hono's handlers
- close three gaps in global chat found in review
- deliver messages published while a subscriber loads history
- answer mutations with the caller's viewer projection
- show a cancelled screen instead of a blank page
- keep the profile header at two lines while editing
- add bottom margin to field label
- stop leaking the RNG seed and repair the replay endpoint
- follow the Google OAuth redirect
- trust the Vite origin in development
- let signed-out visitors read the public game list
- give the container a writable data dir and resolve client IPs

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
