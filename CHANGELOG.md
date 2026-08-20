# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
