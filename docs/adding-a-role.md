# Adding a role

A role touches five workspaces. Miss one and the game still compiles, still passes
most of the suite, and is quietly wrong in a live match — a role nobody can be
dealt, a screen that renders a wolf as a villager, a draw that shifts every other
outcome.

Work in this order. The compiler and the i18n test between them enumerate most of
what is left, so lean on them rather than on memory.

## 1. Name it in the protocol

`packages/protocol/src/enums.ts` — append the id to `ROLE_IDS`. Append rather than
insert: the tuple order carries no meaning, and appending keeps the diff honest.

Also here, if they apply:

- an action the role performs at night → append to `ACTION_IDS`
- a role on the wolf side → add to `WOLF_ROLE_IDS`
- a new reason a player changes role → add to `CONVERSION_CAUSES`

Ids are wire vocabulary: never renamed, never translated, never pluralised.

**Done when** `bun run --filter '*' typecheck` fails *only* on the registry and the
translations. `roleRegistry` is a `Record<RoleId, …>` and the i18n resources are
typed, so from here the compiler is your checklist.

## 2. Write the role module

`packages/game-engine/src/roles/<role>.ts`, mirroring the nearest existing role —
most are six lines. Register it in `roles/registry.ts`.

A role declares an `id`, a `startingFaction`, its `createState`, and at most the two
hooks in `RoleDefinition`. Behaviour that reacts to other players is not written
here; the central resolver owns it, and roles never trigger each other.

## 3. Put it in the composer

`composer/balance-v1.ts`:

- `availableSpecialRoles` — the pool the composer draws from. Omit this and the role
  exists but is never dealt.
- `roleAvailabilityMinimums` — the smallest game it may appear in.
- `wolfCountForComposition` — only if the role changes the size of the pack.

`composer/constraints.ts` — add the id to `hasValidSpecialCardinality` so a
composition cannot contain two of it.

## 4. Give it behaviour

Night behaviour is positional and lives in `resolution/night.ts`: intents freeze in
`freezeNightIntents`, every living player is placed in a house by
`resolveNightLocations`, and `resolveHouseAttacks` resolves what happens there in a
fixed order. Add to that order deliberately — where a branch sits decides which role
beats which, and getting it wrong is invisible until a real game.

Day behaviour belongs in the role's `onDaySelected` or in `resolution/vote.ts`.
A win condition belongs in `resolution/victory.ts`, which counts by faction.

## 5. Translate it

`packages/i18n/src/resources/en.ts` and `es.ts` — a `name` and a `description` under
`roles`, in both. A faction entry is only needed for a genuinely new faction.

## 6. Show it, if a viewer must tell it apart

Only when the role has to be distinguishable on screen. The client may not import
`game-engine` — `scripts/check-boundaries.ts` enforces it — so anything the client
needs to know about roles comes from `protocol`.

## 7. Test it

Table-driven, next to the cases for the roles it interacts with. Cover the rule, the
roles it does *not* apply to, and the interaction with any role that resolves before
it.

---

## Traps

These cost real time. None of them is visible in a diff.

**There are two `night.test.ts`.** `commands/night.test.ts` covers validation and
storage; `resolution/night.test.ts` covers what actually happens at night. Night
behaviour is tested in the second.

**The i18n test is your red test.** `packages/i18n/src/index.test.ts` asserts every
`RoleId` has a name and a description in both locales, so it fails the moment you
add the id and passes when the copy lands. Start there and let it drive you.

**A wolf-faction role does not automatically get wolf chat.** `WOLF_ROLE_IDS`
(protocol) is who *is* a wolf, for display. `WOLF_CHAT_ROLES` (engine registry) is
who may *read and write* the wolf channel, and it gates both `projection/permissions.ts`
and `commands/validate.ts`. A role can be in the first and not the second.

**New randomness needs its own derived scope.** Reuse the existing shape —
`rng.derive("night:<day>:<role>:<purpose>")`. Deriving by semantic scope is what
keeps a new draw from shifting every existing outcome for the same seed. Reordering
or reusing an existing `derive` call breaks determinism for every game already
played.

**A converted player's role is patched to `werewolf`**, not left as what they were.
`projection/permissions.ts` keys full wolf-chat history on `originalRole`, so
conversion history stays hidden from the newcomer.

**Fixtures can encode states the engine cannot produce.** Several test helpers set
`role` and `faction` independently, so it is easy to write a player who is
faction `wolves` with a village role — a state no composition or patch can create.
A test built on one proves nothing. `makeState` in `resolution/night.test.ts` maps
role to faction for you; use it rather than assembling a player by hand.

**A test that needs a particular role dealt must pin the seed.** Compositions are
seeded from a per-game random uuid, so a test that assumes a wolf exists is rolling
dice — and a five-player composition containing the serial killer has no wolves at
all. `startGameWithSeed` in `apps/server/src/test/harness.ts` pins it; the seed must
be written before the start endpoint reads it.
