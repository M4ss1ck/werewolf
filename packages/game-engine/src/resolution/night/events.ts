import type { NightDeathCause, UserId } from "@werewolf/protocol";
import type { DomainTransition, GameState, PlayerPatch } from "../../state.ts";
import { getLinkPair } from "../link.ts";
import { livingPlayers, type NightOutcome } from "./context.ts";
import { type FrozenIntents, intentsFor, mimickedIntent, realIntent } from "./freeze.ts";
import type { NightRolls } from "./rolls.ts";

export function makeNightEvents(
  state: GameState,
  frozen: FrozenIntents,
  targetId: UserId | null,
  outcome: NightOutcome,
  rolls: NightRolls,
): DomainTransition["events"] {
  const events: DomainTransition["events"] = [
    { kind: "night.resolved", scope: "public", payload: { deaths: [...outcome.deaths.keys()] } },
  ];
  for (const [playerId] of outcome.deaths) {
    const player = state.players[playerId]!;
    events.push({
      kind: "player.eliminated",
      scope: "public",
      // Every night death reports the same cause; the precise mechanism is
      // recorded only in the server-scope audit.night event below.
      payload: { playerId, role: player.role!, cause: "night" },
    });
  }
  const seer = realIntent(frozen, "seer.inspect");
  if (seer)
    events.push({
      kind: "seer.result",
      scope: "player",
      scopeId: seer.actorId,
      payload: { targetId: seer.targetId!, role: state.players[seer.targetId!]!.role! },
    });
  const sorcerer = realIntent(frozen, "sorcerer.divine");
  if (sorcerer)
    events.push({
      kind: "sorcerer.result",
      scope: "player",
      scopeId: sorcerer.actorId,
      payload: {
        targetId: sorcerer.targetId!,
        isWolf: state.players[sorcerer.targetId!]!.faction === "wolves",
      },
    });
  const drunkSeer = mimickedIntent(frozen, "seer.inspect");
  if (drunkSeer)
    events.push({
      kind: "seer.result",
      scope: "player",
      scopeId: drunkSeer.actorId,
      payload: {
        targetId: drunkSeer.targetId!,
        role: rolls.fakeInspections.get(drunkSeer.actorId)!,
      },
    });
  // The result is emitted whether or not the investigator survives: they saw
  // what they saw before anything happened to them.
  const detective = realIntent(frozen, "detective.investigate");
  if (detective)
    events.push({
      kind: "detective.result",
      scope: "player",
      scopeId: detective.actorId,
      payload: {
        targetId: detective.targetId!,
        role: rolls.investigations.get(detective.actorId) ?? null,
      },
    });
  const drunkDetective = mimickedIntent(frozen, "detective.investigate");
  if (drunkDetective)
    events.push({
      kind: "detective.result",
      scope: "player",
      scopeId: drunkDetective.actorId,
      payload: {
        targetId: drunkDetective.targetId!,
        role: rolls.investigations.get(drunkDetective.actorId) ?? null,
      },
    });
  const harlotVisit = realIntent(frozen, "harlot.visit");
  const harlotStay = realIntent(frozen, "harlot.stay");
  if (harlotVisit || harlotStay) {
    const harlotId = (harlotVisit ?? harlotStay)!.actorId;
    const killed = [...outcome.deaths.keys()].includes(harlotId);
    events.push({
      kind: "harlot.result",
      scope: "player",
      scopeId: harlotId,
      payload: { outcome: killed ? "killed" : "safe" },
    });
  }
  // The Lone Wolf learns whether it found the Alpha. `found: true` means a
  // clash happened; `false` is a real deduction tool, not a silent miss.
  if (outcome.loneWolfResult)
    events.push({
      kind: "lone_wolf.result",
      scope: "player",
      scopeId: outcome.loneWolfResult.playerId,
      payload: {
        targetId: outcome.loneWolfResult.targetId,
        found: outcome.loneWolfResult.found,
      },
    });
  // On ascension the Lone Wolf becomes the Alpha and joins the pack. The
  // surviving pack is told only after the fact, through this same event, which
  // also writes the channel marker so the new Alpha reads wolf chat only from
  // this moment on.
  if (outcome.ascension)
    events.push({
      kind: "wolves.member_joined",
      scope: "faction",
      scopeId: "wolves",
      payload: { playerId: outcome.ascension.playerId },
    });
  for (const { playerId, cause } of outcome.conversions) {
    if (cause === "cult") {
      events.push({
        kind: "player.converted",
        scope: "player",
        scopeId: playerId,
        payload: { role: "cultist", faction: "cult", cause },
      });
      events.push({
        kind: "cult.member_joined",
        scope: "faction",
        scopeId: "cult",
        payload: { playerId },
      });
    } else {
      events.push({
        kind: "player.converted",
        scope: "player",
        scopeId: playerId,
        payload: { role: "werewolf", faction: "wolves", cause },
      });
      events.push({
        kind: "wolves.member_joined",
        scope: "faction",
        scopeId: "wolves",
        payload: { playerId },
      });
    }
  }
  const skVisit = realIntent(frozen, "serial_killer.visit");
  const skStay = realIntent(frozen, "serial_killer.stay");
  events.push({
    kind: "audit.night",
    scope: "server",
    payload: {
      phaseId: state.phase!.id,
      wolfVotes: intentsFor(frozen, "wolf.attack").map((intent) => ({
        playerId: intent.actorId,
        targetId: intent.targetId ?? null,
      })),
      wolfTarget: targetId,
      seerInspection: seer
        ? { targetId: seer.targetId!, role: state.players[seer.targetId!]!.role! }
        : null,
      harlotAction: harlotVisit
        ? { type: "visit", targetId: harlotVisit.targetId! }
        : harlotStay
          ? { type: "stay" }
          : null,
      serialKillerAction: skVisit
        ? { type: "visit", targetId: skVisit.targetId! }
        : skStay
          ? { type: "stay" }
          : null,
      deaths: [...outcome.deaths.entries()].map(([playerId, cause]) => ({ playerId, cause })),
      conversions: outcome.conversions.map(({ playerId }) => playerId),
    },
  });
  return events;
}

export function commitNight(outcome: NightOutcome): PlayerPatch[] {
  const patches: PlayerPatch[] = [];
  for (const [playerId] of outcome.deaths) patches.push({ playerId, changes: { status: "dead" } });
  for (const { playerId, cause } of outcome.conversions) {
    if (cause === "cult") {
      patches.push({ playerId, changes: { role: "cultist", faction: "cult" } });
    } else {
      patches.push({ playerId, changes: { role: "werewolf", faction: "wolves" } });
    }
  }
  if (outcome.ascension)
    patches.push({
      playerId: outcome.ascension.playerId,
      changes: { role: "alpha_wolf", faction: "wolves" },
    });
  return patches;
}

/** Roll the priest's and guardian's role state forward. The priest's
 * `lastProtectedId` becomes whoever they protected this night (null if they
 * protected nobody), so the no-repeat rule carries into the next night. The
 * guardian's `protegeeId` is fixed on night 1 when they bond and never changes
 * again. Both key on the TRUE role, so a Drunk-Priest or Drunk-Guardian is
 * never patched. */
export function roleStatePatches(state: GameState, frozen: FrozenIntents): PlayerPatch[] {
  const patches: PlayerPatch[] = [];
  const priest = livingPlayers(state).find((player) => player.role === "priest");
  const priestProtect = realIntent(frozen, "priest.protect");
  if (priest)
    patches.push({
      playerId: priest.id,
      changes: { roleState: { lastProtectedId: priestProtect?.targetId ?? null } },
    });
  const guardian = livingPlayers(state).find((player) => player.role === "guardian");
  const guardianBond = realIntent(frozen, "guardian.bond");
  if (guardian && guardianBond)
    patches.push({
      playerId: guardian.id,
      changes: { roleState: { protegeeId: guardianBond.targetId! } },
    });
  return patches;
}

/** If exactly one member of an established pair is in `deaths` and the other is
 * alive, the other dies too with cause "lover_link". ONE pass only. */
export function applyLoverLinkDeaths(state: GameState, deaths: Map<UserId, NightDeathCause>): void {
  const pair = getLinkPair(state);
  if (!pair) return;
  const [a, b] = pair;
  const aDead = deaths.has(a);
  const bDead = deaths.has(b);
  if (aDead && !bDead && state.players[b]?.status === "alive") deaths.set(b, "lover_link");
  else if (bDead && !aDead && state.players[a]?.status === "alive") deaths.set(a, "lover_link");
}

/** Form the cupid's link on night 1: patch the cupid's roleState and tell each
 * lover who the other is. No-op once a link already exists. A Drunk-Cupid who
 * picked themselves is told they are linked, but no real pair is stored. */
export function formLink(
  state: GameState,
  frozen: FrozenIntents,
): { patches: PlayerPatch[]; events: DomainTransition["events"] } {
  const patches: PlayerPatch[] = [];
  const events: DomainTransition["events"] = [];
  const cupidLink = realIntent(frozen, "cupid.link");
  if (cupidLink) {
    const cupid = state.players[cupidLink.actorId];
    if (cupid && isCupidUnlinked(cupid.roleState)) {
      const [a, b] = cupidLink.targetIds!;
      patches.push({ playerId: cupid.id, changes: { roleState: { linked: [a, b] } } });
      events.push(
        { kind: "player.linked", scope: "player", scopeId: a, payload: { partnerId: b } },
        { kind: "player.linked", scope: "player", scopeId: b, payload: { partnerId: a } },
      );
    }
  }
  const drunkCupidSelfLink = intentsFor(frozen, "cupid.link").find(
    (intent) => intent.mimicked && intent.targetIds!.includes(intent.actorId),
  );
  if (drunkCupidSelfLink) {
    const [a, b] = drunkCupidSelfLink.targetIds!;
    const partnerId = a === drunkCupidSelfLink.actorId ? b : a;
    events.push({
      kind: "player.linked",
      scope: "player",
      scopeId: drunkCupidSelfLink.actorId,
      payload: { partnerId },
    });
  }
  return { patches, events };
}

function isCupidUnlinked(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "linked" in value &&
    (value as { linked: unknown }).linked === null
  );
}

export function applyPatches(state: GameState, patches: PlayerPatch[]): GameState {
  const players = { ...state.players };
  for (const patch of patches)
    players[patch.playerId] = { ...players[patch.playerId]!, ...patch.changes };
  return { ...state, players };
}
