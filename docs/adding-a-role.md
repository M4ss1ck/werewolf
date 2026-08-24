# Adding a role

A role is one file. The engine derives everything it can from what that file
declares — what the composer may deal, what the client renders, what the server
accepts, what a bot may pick — so the work outside the role module is naming the
role in the protocol and writing its copy.

Night *behaviour* is the exception, and deliberately so. Resolution order is a
property of the game, not of any role, and it stays in one place where it can be
read top to bottom.

Work in this order. The compiler and the i18n test between them enumerate most of
what is left, so lean on them rather than on memory.

## 1. Name it in the protocol

`packages/protocol/src/enums.ts` — append the id to `ROLE_IDS`. Append rather than
insert: the tuple order carries no meaning for the rules, and appending keeps the
diff honest.

Also here, if they apply:

- an action the role performs → append to `ACTION_IDS`
- a role on the wolf side → add to `WOLF_ROLE_IDS`
- a new reason a player changes role → add to `CONVERSION_CAUSES`

Ids are wire vocabulary: never renamed, never translated, never pluralised.

**Done when** `bun run --filter '*' typecheck` fails *only* on the registry and the
translations. `roleRegistry` is a `Record<RoleId, …>` and the i18n resources are
typed, so from here the compiler is your checklist.

## 2. Write the role module

`packages/game-engine/src/roles/<role>.ts`, registered in `roles/registry.ts`.
This is where the whole role lives. The simplest is five lines:

```ts
import type { RoleDefinition } from "./registry.ts";
export const villager: RoleDefinition = {
  id: "villager",
  startingFaction: "village",
  createState: () => ({}),
};
```

A role with a power, its own state, and a rule that resists declaration — the
Priest is the fullest example in the tree:

```ts
import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

function lastProtectedId(value: unknown): UserId | null {
  if (typeof value !== "object" || value === null || !("lastProtectedId" in value)) return null;
  return (value as { lastProtectedId: UserId | null }).lastProtectedId ?? null;
}

export const priest: RoleDefinition<{ lastProtectedId: UserId | null }> = {
  id: "priest",
  startingFaction: "village",
  createState: () => ({ lastProtectedId: null }),
  composition: { minimumPlayers: 7, drunkMayBelieve: true },
  actions: [
    {
      id: "priest.protect",
      phase: "night",
      // The priest may protect themselves, but never the same player on two
      // consecutive nights.
      target: { kind: "one", pool: "all", excludeSelf: false },
      eligible: ({ player, target }) => target.id !== lastProtectedId(player.roleState),
    },
  ],
};
```

### `composition` — how the composer may deal it

| Field | Meaning |
|---|---|
| `minimumPlayers` | smallest game it may appear in; absent means any size |
| `copies` | how many are dealt when drawn; absent means one (`mason` is 2) |
| `replacesWolf` | takes a plain wolf's seat instead of adding a body to the pack |
| `requires` | cannot be dealt unless that role is dealt too |
| `drunkMayBelieve` | a Drunk may be told they are this role |

**Omitting `composition` means the role is never dealt.** That is a statement, not
a default — see the trap below.

`roles/composition.ts` derives `availableSpecialRoles`, `roleAvailabilityMinimums`,
`WOLF_REPLACING_ROLES`, `requiredCombinations` and `DRUNK_FAKE_ROLES` from these.
There is no separate composer step any more; if you are looking for the place to
add your role to a list in `balance-v1.ts`, there isn't one.

Two things do stay in `composer/balance-v1.ts`, because they are relations between
roles rather than facts about one: `forbiddenCombinations` (Seer with Princess at
5–6 players) and the Cursed's ban at exactly 5 or 7 players. Preset pools stay
explicit too — which roles make up "classic" is curation, not something derivable.

### `actions` — what the role may do

One declaration drives three consumers that used to be maintained by hand: the
model the client renders from, the check the server validates against, and the
moves a bot may pick. They cannot disagree, because there is only one of them.

| Field | Meaning |
|---|---|
| `id` | must already exist in `ACTION_IDS` |
| `phase` | `"night"`, or `"day"` meaning either day phase |
| `target` | `null` for no target, or `{ kind: "one" \| "pair", pool, excludeSelf }` |
| `available` | extra gate beyond "alive and perceives this role" |
| `eligible` | extra target predicate beyond "alive and in pool" |
| `travelsToTarget` | the actor walks to the target's house at night |

`pool` is `"others"` or `"all"`; `"all"` plus `excludeSelf: false` is how the
Priest and Cupid may pick themselves.

Reach for `available` and `eligible` only when a rule genuinely cannot be
declared. There are five in the whole tree.

### `channels` and `packMember`

Only for a role in a faction chat or the wolf ballot. Both are by ROLE, never by
faction — see the trap below.

### Outcome hooks

| Hook | Meaning |
|---|---|
| `contests` | `true` only while the living true role can keep an outcome unsettled; it is checked before a bloc is declared doomed. |
| `onDaySelected` | Optional day-selection effect, such as the Princess's one-time save. |

When checking a role's checklist, add `contests` only for a role whose living
state can genuinely prevent a victory. Terminal doom writes finish every living
loser after the winner is decided and do not invoke role effects or cascades.

## 3. Give it night behaviour, if it needs any

Most roles need none: declaring an action is enough to have it offered, validated,
stored and, if it travels, to put the actor in the right house.

You are writing engine code only if the role introduces a new *kind* of
interaction — a new way to die, protect, convert or clash. That lives in
`resolution/night/`:

- `freeze.ts`, `locations.ts` — generic; you should not need to touch them
- `rolls.ts` — the night's dice
- `stages/` — one file per stage
- `attacks.ts` — **the order**, as an ordered list of stage calls

Add to that order deliberately. Where a stage sits decides which role beats which,
and getting it wrong is invisible until a real game. Read `attacks.ts` top to
bottom before changing it; the comments explain why each stage is where it is.

Day behaviour belongs in the role's `onDaySelected` or in `resolution/vote.ts`.
A win condition belongs in `resolution/victory.ts`, which counts by faction.

## 4. Translate it

`packages/i18n/src/resources/en.ts` and `es.ts` — a `name` and a `description`
under `roles`, in both. An action needs a `label` and a `prompt`. A faction entry
is only needed for a genuinely new faction.

## 5. Show it, if a viewer must tell it apart

Only when the role has to be distinguishable on screen. The client may not import
`game-engine` — `scripts/check-boundaries.ts` enforces it — so anything the client
needs about roles comes from `protocol`. It renders night controls from the
server's action model and holds no role knowledge of its own; adding an action
does not mean touching the client.

## 6. Test it

Table-driven, next to the cases for the roles it interacts with. Cover the rule,
the roles it does *not* apply to, and the interaction with any role that resolves
before it.

---

## Traps

These cost real time. None of them is visible in a diff.

**A role with no `composition` is never dealt.** The Lone Wolf shipped complete —
role, nightly search, duel with the Alpha, ascension, 256 lines of tests — and was
absent from `availableSpecialRoles`, so no composition could contain it and nobody
ever played it. Nothing failed. `roles/composition.test.ts` now asserts every role
is either dealt or on the short `NEVER_DEALT` list, so the omission fails the gate;
if your role really is undealt, say so there rather than leaving it out.

**A wolf-faction role does not automatically get wolf chat.** `WOLF_ROLE_IDS`
(protocol) is who *is* a wolf, for display. `channels: ["wolves"]` on the role
module is who may *read and write* the channel, and `packMember` is who holds a
seat in the ballot. The Sorcerer is in the first and neither of the others.

**There are two `night.test.ts`.** `commands/night.test.ts` covers validation and
storage; `resolution/night.test.ts` covers what actually happens at night. Night
behaviour is tested in the second.

**The i18n test is your red test.** `packages/i18n/src/index.test.ts` asserts every
`RoleId` has a name and a description in both locales, so it fails the moment you
add the id and passes when the copy lands. Start there and let it drive you.

**New randomness needs its own derived scope.** Reuse the existing shape —
`rng.derive("night:<day>:<role>:<purpose>")`, in `rolls.ts`. Deriving by semantic
scope is what keeps a new draw from shifting every existing outcome for the same
seed.

**The pool's ORDER decides a seeded draw.** `availableSpecialRoles` derives from
`ROLE_IDS`, so appending a role shifts which composition some seeds produce. That
is expected and harmless, but it moves the pinned fixture in
`resolution/drunk.test.ts`. Re-record it; do not re-record a test that asserts a
rule.

**Effects ignore a mimicked actor; locations do not.** A Drunk who believes they
are the Detective stores `detective.investigate` and genuinely walks to that house
and genuinely dies there, but investigates nothing. Read intents with `realIntent`
for an effect and plain `soleIntent`/`intentsFor` for a location. Several roles
cannot be mimicked today only because they lack `drunkMayBelieve`; adding it must
not quietly hand the fake a real power.

**A converted player's role is patched to `werewolf`**, not left as what they were.
`projection/permissions.ts` keys full wolf-chat history on `originalRole`, so
conversion history stays hidden from the newcomer.

**Fixtures can encode states the engine cannot produce.** Several test helpers set
`role` and `faction` independently, so it is easy to write a player who is faction
`wolves` with a village role — a state no composition or patch can create. A test
built on one proves nothing. `makeState` in `resolution/night.test.ts` maps role to
faction for you; use it rather than assembling a player by hand.

**A test that needs a particular role dealt must pin the seed.** Compositions are
seeded from a per-game random uuid, so a test that assumes a wolf exists is rolling
dice — and a five-player composition containing the serial killer has no wolves at
all. `startGameWithSeed` in `apps/server/src/test/harness.ts` pins it; the seed must
be written before the start endpoint reads it.
