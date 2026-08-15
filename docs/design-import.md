# Mobile design import — what landed, and what the design asked for that we did not build

Source: Claude Design project *Werewolf app modernization*, file `Werewolf Mobile.dc.html`
(11 screens at 412×892, plus the `android-frame.jsx` mockup wrapper and the
generated `support.js` runtime — neither of those is product code).

This document exists so the next person does not re-litigate the gaps. It records
three things: the backend surface the design forced us to add, the places where the
design and a load-bearing invariant disagreed, and the design elements deliberately
left unbuilt.

---

## 1. Backend changes the design required

### 1.1 `GET /api/games` now returns an allowlist, not raw rows

Before, the route serialized whole `games` rows. That published two columns that
must never leave the server:

- **`rngSeed`** — resolution is deterministic from `state + frozen intents +
  balance version + seed`. A client holding the seed can precompute role
  assignment and every night resolution. This was the more serious of the two.
- **`joinCode`** — the credential for a private game.

It also published `settingsJson`, `winnerJson` and `version`, none of which the
browser needs.

`PublicGameSummary` (`packages/protocol/src/summaries.ts`) is now the contract, and
a server test asserts the serialized body contains none of those keys. The summary
carries what screen 03 actually draws: name, status, visibility, day, player count,
the player names behind the avatar stack, `scheduledAt` for the countdown, and
`phase` while running.

### 1.2 `GET /api/games/:id/replay` was broken, not just untidy

It returned the raw `GameState`, whose `players` is a `Record<UserId, PlayerState>`,
while `apps/client/src/api/client.ts` declared the response as
`ViewerGameSnapshot`, whose `players` is an array. Any render of the replay route
threw. It also returned every event including server-scope `audit.*` rows.

Now it returns a projected `snapshot` plus events filtered through
`filterVisibleEvents`, matching what `GET /api/games/:id/events` already did.

**This narrowed the replay deliberately.** The previous test asserted that replay
returned "the hidden history" — server-scope `audit.vote` and `audit.night` rows,
and every player's `originalRole`. That contradicted the stated invariant that
server audit events must never reach a viewer projection, so the projection now
wins and audit rows stay server-side. Screen 10's replay timeline is unaffected:
every line it draws (`Mattias was voted out`, `Bram was killed`, `The village
abstained`) comes from the public `vote.resolved`, `player.eliminated` and
`night.resolved` events.

If a post-mortem replay is meant to expose per-voter and per-wolf detail once the
game is over, that is a real product decision — it means qualifying the invariant
in `AGENTS.md` with "while the game is running" and giving `filterVisibleEvents` a
finished-game branch. It should not be re-introduced by accident.

### 1.3 Snapshot additions

| Field | Why | Visibility rule |
|---|---|---|
| `voteTallies` | Screen 07 draws a count and a fill bar per candidate | Aggregate counts only; present only during a `voting` phase |
| `game.winner` | Screen 10 announces which faction won and why | Present only when `status === "finished"` |
| `revealedRole` on living players | Screen 10 reveals the whole table | Only when `status === "finished"`; unchanged mid-game |
| `me.currentIntent` typed as `ViewerIntent` | Screens 07/08 need to render your own locked vote and selected target | It was already sent — it was just typed `unknown` |

### 1.4 `GET /api/me/stats`

Screen 11 shows games played, survival rate and times as wolf. These are derived
from `game_players` joined to finished `games` — no new table, no new column, no
migration. Spectated and unfinished games are excluded.

---

## 2. Where the design and an invariant disagreed

### 2.1 Voting is aggregate-only (design 07 shows voter avatars)

The design places small avatars of *who voted for whom* next to each candidate
during the voting phase. `AGENTS.md` states that individual votes during a match
must never reach a viewer projection, and `audit.vote` is deliberately
server-scope for exactly this reason.

**Resolution: the invariant wins.** The client renders the tally count and the fill
bar; it renders no voter identity, because the server sends none. A client test
asserts the voting screen contains no voter identity, and it is written as a
security test rather than a UI test.

If public voting is ever wanted as a *game rule*, that is a deliberate design
decision: it means changing the invariant in `AGENTS.md`, adding voters to
`voteTallies`, and revisiting `canViewEvent`. It is not a UI change.

### 2.2 Night targets: no "Seen night 1" state

Design 08 shows a disabled target labelled `Seen night 1` — a Seer who cannot
re-inspect someone they already read. The engine has no such rule: `seer.inspect`
disables only dead players. Adding it would change role behaviour and the balance
of the Seer, which is a rules change, not an import of a mockup.

The client renders exactly the `enabled` flag the server sends. If the rule is
wanted, it belongs in `getAvailableActions` with its own tests, and
`AvailableAction.targets` would need a reason code so the client can say *why* a
target is disabled without inventing prose.

### 2.3 The "Village" tab is ours, not the design's

Screens 06–09 share a four-item tab bar — Village / Talk / Act / Me — but the
design never draws the Village tab. It is built from primitives the other screens
establish: the phase header, the alive/dead avatar grid from screen 09, and the
public event timeline. No new visual language was invented for it.

---

### 2.4 The mockup's tap targets are spans

Every interactive element in the design file is a `<span>` or a `<div>` — it is a
picture, not markup to copy. The screens use real `<button>`, `<input>`,
`<fieldset>` radio groups and `role="switch"` toggles, so the keyboard and a
screen reader get what the thumb gets. Where the design and accessibility
disagree, accessibility won; the result is visually identical.

## 3. Deliberately not built

- **Server-side push notifications.** Out of scope in `AGENTS.md`. The Profile
  screen's "Phase notifications" toggle is a client-local preference that gates an
  in-app notification while the app is open. It stores nothing on the server.
- **A server preference store.** "Reduced motion" and the notification toggle live
  in `localStorage`. `PATCH /api/me/locale` remains the echo endpoint it already
  was; language is a client concern.
- **The Android device frame.** `android-frame.jsx` is mockup chrome — status bar,
  gesture pill, Gboard. It is not product UI and was not ported.
- **Profile stats beyond the three tiles.** Rankings and achievements are
  explicitly out of scope; the three tiles are plain aggregates over existing rows.

---

## 4. Fonts

The design calls for Space Grotesk and Space Mono from Google Fonts. `index.css`
holds a no-remote-fonts rule and the app ships as a Tauri desktop and Android
shell, where a font CDN is unreachable. Both families are vendored as woff2
subsets (latin + latin-ext) under `apps/client/public/fonts/` and declared with
local `@font-face` rules. Space Grotesk is the variable face at `300 700`.

Both are licensed under the SIL Open Font License 1.1.

---

## 5. Two bugs the import surfaced

Neither is a design question; both were latent and are fixed.

**The game list leaked the RNG seed.** `GET /api/games` serialized whole `games`
rows, so `rng_seed` and `join_code` went to every browser that opened the lobby
list. Resolution is deterministic from state, frozen intents, balance version and
seed, so a client holding the seed can precompute role assignment and every night.
Building the browser screen is what made someone look at that payload.

**The replay endpoint had never worked.** It returned the raw `GameState`, whose
`players` is a record, while the client declared the response as a viewer
snapshot, whose `players` is an array. Every render of the replay route threw.
Nothing caught it because no screen reached it.

The lesson worth keeping: both were found by giving an existing endpoint a real
consumer. A route with no screen behind it is untested surface.
