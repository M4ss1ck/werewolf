import type { ConversionCause, NightDeathCause, RoleId, UserId } from "@werewolf/protocol";
import { ROLE_IDS } from "@werewolf/protocol";
import { ALPHA_CONVERSION_CHANCE, DETECTIVE_SUCCESS_CHANCE } from "../composer/balance-v1.ts";
import type { SeededRng } from "../rng/rng.ts";
import { getPerceivedRole } from "../roles/perceived.ts";
import { isPackMember } from "../roles/registry.ts";
import type {
  DomainResult,
  DomainTransition,
  GameState,
  PlayerPatch,
  PlayerState,
} from "../state.ts";
import { getLinkPair } from "./link.ts";
import { checkVictory } from "./victory.ts";

export interface NightResolutionContext {
  now: number;
  rng: SeededRng;
}

type FrozenNight = {
  wolfVotes: { playerId: UserId; targetId: UserId | null }[];
  seerInspection: { playerId: UserId; targetId: UserId; role: RoleId } | null;
  drunkFakeResult: { playerId: UserId; targetId: UserId; role: RoleId } | null;
  harlotAction:
    | { playerId: UserId; type: "stay" }
    | { playerId: UserId; type: "visit"; targetId: UserId }
    | null;
  serialKillerAction:
    | { playerId: UserId; type: "stay" }
    | { playerId: UserId; type: "visit"; targetId: UserId }
    | null;
  cupidLink: { playerId: UserId; targetIds: [UserId, UserId] } | null;
  drunkCupidSelfLink: { playerId: UserId; partnerId: UserId } | null;
  priestProtect: { playerId: UserId; targetId: UserId } | null;
  guardianBond: { playerId: UserId; targetId: UserId } | null;
  sorcererDivine: { playerId: UserId; targetId: UserId; isWolf: boolean } | null;
  /** The real Detective's investigation. `role: null` means inconclusive. */
  detectiveInvestigation: { playerId: UserId; targetId: UserId; role: RoleId | null } | null;
  /** A Drunk who believes they are the Detective. Same shape as the real
   * result: sometimes a uniformly random role, sometimes null. */
  drunkFakeDetective: { playerId: UserId; targetId: UserId; role: RoleId | null } | null;
  /** The cult leader's conversion target. The leader travels to the target's
   * house and converts them; the conversion is not a hit. */
  cultConvert: { playerId: UserId; targetId: UserId } | null;
  /** The Lone Wolf's nightly hunt: the house they searched for the Alpha. The
   * Lone Wolf travels there. */
  loneWolfSearch: { playerId: UserId; targetId: UserId } | null;
};

type NightOutcome = {
  deaths: Map<UserId, NightDeathCause>;
  conversions: { playerId: UserId; cause: ConversionCause }[];
  /** The Lone Wolf won the duel and ascended to Alpha this night. */
  ascension: { playerId: UserId } | null;
  /** The Lone Wolf's search result for this night. */
  loneWolfResult: { playerId: UserId; targetId: UserId; found: boolean } | null;
};

export function resolveNight(state: GameState, context: NightResolutionContext): DomainResult {
  if (!state.phase || state.phase.type !== "night")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  const frozen = freezeNightIntents(state, context.rng, state.day);
  const seer = frozen.seerInspection;
  const targetId = resolveWolfBallot(frozen.wolfVotes);
  const locations = resolveNightLocations(state, frozen, targetId);
  const outcome = resolveHouseAttacks(state, frozen, targetId, locations, context.rng, state.day);
  applyLoverLinkDeaths(state, outcome.deaths);
  const link = formLink(state, frozen);
  const playerPatches = [
    ...commitNight(outcome),
    ...link.patches,
    ...roleStatePatches(state, frozen),
  ];
  const nextNightsWithoutElimination =
    outcome.deaths.size > 0 ? 0 : state.nightsWithoutElimination + 1;
  const projected = {
    ...applyPatches(state, playerPatches),
    nightsWithoutElimination: nextNightsWithoutElimination,
  };
  const events = [...makeNightEvents(state, frozen, targetId, outcome, seer), ...link.events];
  const winner = checkVictory(projected);
  if (winner) {
    events.push({ kind: "game.finished", scope: "public", payload: winner });
    return {
      ok: true,
      transition: {
        gamePatch: {
          status: "finished",
          winner,
          nightsWithoutElimination: nextNightsWithoutElimination,
        },
        playerPatches,
        events,
        ephemeral: [],
      },
    };
  }
  const nextPhase = {
    id: (state.phase.id + 1) as typeof state.phase.id,
    type: "discussion" as const,
    startedAt: context.now,
    endsAt: context.now + state.settings.discussionDurationMs,
  };
  events.push({
    kind: "phase.started",
    scope: "public",
    payload: {
      phaseId: nextPhase.id,
      type: nextPhase.type,
      startedAt: nextPhase.startedAt,
      endsAt: nextPhase.endsAt,
    },
  });
  return {
    ok: true,
    transition: {
      gamePatch: {
        day: state.day + 1,
        phase: nextPhase,
        nightsWithoutElimination: nextNightsWithoutElimination,
      },
      playerPatches,
      events,
      ephemeral: [],
    },
  };
}

function freezeNightIntents(state: GameState, rng: SeededRng, day: number): FrozenNight {
  const phaseId = state.phase!.id;
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  const wolfVotes = living
    .filter((player) => isPackMember(player))
    .map((player) => ({ player, action: currentAction(player, phaseId, "wolf.attack") }))
    .filter(({ action }) => action?.targetId && isLivingTarget(state, action.targetId))
    .map(({ player, action }) => ({ playerId: player.id, targetId: action!.targetId! }));
  const seer = living.find((player) => player.role === "seer");
  const seerAction = seer ? currentAction(seer, phaseId, "seer.inspect") : undefined;
  const seerInspection =
    seerAction?.targetId && isLivingTarget(state, seerAction.targetId)
      ? {
          playerId: seer!.id,
          targetId: seerAction.targetId,
          role: state.players[seerAction.targetId]!.role!,
        }
      : null;
  const drunk = living.find(
    (player) => player.role === "drunk" && getPerceivedRole(player) === "seer",
  );
  const drunkAction = drunk ? currentAction(drunk, phaseId, "seer.inspect") : undefined;
  const drunkFakeResult =
    drunkAction?.targetId && isLivingTarget(state, drunkAction.targetId)
      ? {
          playerId: drunk!.id,
          targetId: drunkAction.targetId,
          role: ROLE_IDS[rng.derive(`night:${day}:drunk:fake-result`).int(ROLE_IDS.length)]!,
        }
      : null;
  const harlot = living.find((player) => player.role === "harlot");
  const visit = harlot ? currentAction(harlot, phaseId, "harlot.visit") : undefined;
  const stay = harlot ? currentAction(harlot, phaseId, "harlot.stay") : undefined;
  const harlotAction =
    visit?.targetId && isLivingTarget(state, visit.targetId)
      ? { playerId: harlot!.id, type: "visit" as const, targetId: visit.targetId }
      : stay
        ? { playerId: harlot!.id, type: "stay" as const }
        : null;
  const serialKiller = living.find((player) => player.role === "serial_killer");
  const skVisit = serialKiller
    ? currentAction(serialKiller, phaseId, "serial_killer.visit")
    : undefined;
  const skStay = serialKiller
    ? currentAction(serialKiller, phaseId, "serial_killer.stay")
    : undefined;
  const serialKillerAction =
    skVisit?.targetId && isLivingTarget(state, skVisit.targetId)
      ? { playerId: serialKiller!.id, type: "visit" as const, targetId: skVisit.targetId }
      : skStay
        ? { playerId: serialKiller!.id, type: "stay" as const }
        : null;
  const cupid = living.find((player) => player.role === "cupid");
  const cupidLinkAction = cupid ? currentAction(cupid, phaseId, "cupid.link") : undefined;
  const cupidLink =
    cupidLinkAction?.targetIds && cupidLinkAction.targetIds.length === 2
      ? {
          playerId: cupid!.id,
          targetIds: [cupidLinkAction.targetIds[0]!, cupidLinkAction.targetIds[1]!] as [
            UserId,
            UserId,
          ],
        }
      : null;
  // A Drunk who believes they are Cupid forms no real link, but if they picked
  // THEMSELVES they are told they are linked to the other pick — exactly what a
  // real Cupid would be told, so the two are indistinguishable.
  const drunkCupid = living.find(
    (player) => player.role === "drunk" && getPerceivedRole(player) === "cupid",
  );
  const drunkCupidAction = drunkCupid
    ? currentAction(drunkCupid, phaseId, "cupid.link")
    : undefined;
  const drunkCupidSelfLink =
    drunkCupidAction?.targetIds && drunkCupidAction.targetIds.length === 2
      ? drunkCupidAction.targetIds[0] === drunkCupid!.id
        ? { playerId: drunkCupid!.id, partnerId: drunkCupidAction.targetIds[1]! }
        : drunkCupidAction.targetIds[1] === drunkCupid!.id
          ? { playerId: drunkCupid!.id, partnerId: drunkCupidAction.targetIds[0]! }
          : null
      : null;
  const priest = living.find((player) => player.role === "priest");
  const priestAction = priest ? currentAction(priest, phaseId, "priest.protect") : undefined;
  const priestProtect =
    priestAction?.targetId && isLivingTarget(state, priestAction.targetId)
      ? { playerId: priest!.id, targetId: priestAction.targetId }
      : null;
  const guardian = living.find((player) => player.role === "guardian");
  const guardianAction = guardian ? currentAction(guardian, phaseId, "guardian.bond") : undefined;
  const guardianBond =
    guardianAction?.targetId && isLivingTarget(state, guardianAction.targetId)
      ? { playerId: guardian!.id, targetId: guardianAction.targetId }
      : null;
  // The Sorcerer scries from home, like the Seer. The result is a boolean —
  // wolf-faction or not — never an exact role.
  const sorcerer = living.find((player) => player.role === "sorcerer");
  const sorcererAction = sorcerer ? currentAction(sorcerer, phaseId, "sorcerer.divine") : undefined;
  const sorcererDivine =
    sorcererAction?.targetId && isLivingTarget(state, sorcererAction.targetId)
      ? {
          playerId: sorcerer!.id,
          targetId: sorcererAction.targetId,
          isWolf: state.players[sorcererAction.targetId]!.faction === "wolves",
        }
      : null;
  // The Detective investigates by walking to the target's house; the frozen
  // record carries the resolved result so a night roll happens exactly once.
  // A miss reports inconclusive (null), never a wrong role.
  const detective = living.find((player) => player.role === "detective");
  const detectiveAction = detective
    ? currentAction(detective, phaseId, "detective.investigate")
    : undefined;
  const detectiveInvestigation =
    detectiveAction?.targetId && isLivingTarget(state, detectiveAction.targetId)
      ? {
          playerId: detective!.id,
          targetId: detectiveAction.targetId,
          role:
            rng.derive(`night:${day}:detective:investigation`).float() < DETECTIVE_SUCCESS_CHANCE
              ? state.players[detectiveAction.targetId]!.role!
              : null,
        }
      : null;
  // A Drunk who believes they are the Detective is told the same shape of
  // result as a real one would see: sometimes a uniformly random role,
  // sometimes inconclusive. They walk to the target's house like the real
  // one, because the risk has to be real.
  const drunkDetective = living.find(
    (player) => player.role === "drunk" && getPerceivedRole(player) === "detective",
  );
  const drunkDetectiveAction = drunkDetective
    ? currentAction(drunkDetective, phaseId, "detective.investigate")
    : undefined;
  const drunkFakeDetectiveRng = rng.derive(`night:${day}:drunk:fake-detective`);
  const drunkFakeDetective =
    drunkDetectiveAction?.targetId && isLivingTarget(state, drunkDetectiveAction.targetId)
      ? {
          playerId: drunkDetective!.id,
          targetId: drunkDetectiveAction.targetId,
          role:
            drunkFakeDetectiveRng.float() < DETECTIVE_SUCCESS_CHANCE
              ? ROLE_IDS[drunkFakeDetectiveRng.int(ROLE_IDS.length)]!
              : null,
        }
      : null;
  // The cult leader converts one living player each night. The action is
  // frozen here so the conversion lands even if the leader is killed that
  // same night — they got there and did it.
  const cultLeader = living.find((player) => player.role === "cult_leader");
  const cultConvertAction = cultLeader
    ? currentAction(cultLeader, phaseId, "cult.convert")
    : undefined;
  const cultConvert =
    cultConvertAction?.targetId && isLivingTarget(state, cultConvertAction.targetId)
      ? { playerId: cultLeader!.id, targetId: cultConvertAction.targetId }
      : null;
  // The Lone Wolf hunts the Alpha every night, searching one house. The action
  // is frozen here so the search lands even if the Lone Wolf is killed that
  // same night — they got there and looked.
  const loneWolf = living.find((player) => player.role === "lone_wolf");
  const loneWolfAction = loneWolf
    ? currentAction(loneWolf, phaseId, "lone_wolf.search")
    : undefined;
  const loneWolfSearch =
    loneWolfAction?.targetId && isLivingTarget(state, loneWolfAction.targetId)
      ? { playerId: loneWolf!.id, targetId: loneWolfAction.targetId }
      : null;
  return {
    wolfVotes,
    seerInspection,
    drunkFakeResult,
    harlotAction,
    serialKillerAction,
    cupidLink,
    drunkCupidSelfLink,
    priestProtect,
    guardianBond,
    sorcererDivine,
    detectiveInvestigation,
    drunkFakeDetective,
    cultConvert,
    loneWolfSearch,
  };
}

function currentAction(
  player: PlayerState,
  phaseId: NonNullable<GameState["phase"]>["id"],
  actionId: string,
) {
  return player.phaseState.phaseId === phaseId ? player.phaseState.actions?.[actionId] : undefined;
}

function isLivingTarget(state: GameState, targetId: UserId): boolean {
  return state.players[targetId]?.status === "alive";
}

function resolveWolfBallot(votes: FrozenNight["wolfVotes"]): UserId | null {
  const tally = new Map<UserId, number>();
  for (const vote of votes) tally.set(vote.targetId!, (tally.get(vote.targetId!) ?? 0) + 1);
  const highest = Math.max(0, ...tally.values());
  const winners = [...tally.entries()].filter(([, count]) => count === highest && count > 0);
  return winners.length === 1 ? winners[0]![0] : null;
}

/** Where every living player spends the night: a map from player id to the id
 * of the player whose house they are in. Everyone starts at home; the pack
 * gathers at the balloted target's house (or stay home on a tie or empty
 * ballot), and the harlot, serial killer, detective and cult leader travel to
 * their visit targets. The detective walks to the house it investigates: that
 * is the price of the second information role. The seer never travels: scrying
 * is remote. The sorcerer neither: they are wolf-faction but not one of the
 * pack, so they do not gather with it.
 *
 * Travel keys on whoever STORED the action, not on who is really a detective:
 * a Drunk who believes they are the Detective genuinely walks to that house
 * and genuinely dies there. Locations are about where a body is, not about
 * whether a power is real. */
function resolveNightLocations(
  state: GameState,
  frozen: FrozenNight,
  wolfTargetId: UserId | null,
): Map<UserId, UserId> {
  const locations = new Map<UserId, UserId>();
  for (const player of livingPlayers(state)) locations.set(player.id, player.id);
  if (wolfTargetId !== null) {
    for (const player of livingPlayers(state)) {
      if (isPackMember(player)) locations.set(player.id, wolfTargetId);
    }
  }
  if (frozen.harlotAction?.type === "visit")
    locations.set(frozen.harlotAction.playerId, frozen.harlotAction.targetId);
  if (frozen.serialKillerAction?.type === "visit")
    locations.set(frozen.serialKillerAction.playerId, frozen.serialKillerAction.targetId);
  if (frozen.detectiveInvestigation)
    locations.set(frozen.detectiveInvestigation.playerId, frozen.detectiveInvestigation.targetId);
  if (frozen.drunkFakeDetective)
    locations.set(frozen.drunkFakeDetective.playerId, frozen.drunkFakeDetective.targetId);
  // The cult leader travels to the target's house, exactly as the Detective
  // and Harlot do. They can be killed there.
  if (frozen.cultConvert) locations.set(frozen.cultConvert.playerId, frozen.cultConvert.targetId);
  // The Lone Wolf travels to the house it searches for the Alpha. It can be
  // killed there, and it is there that the duel with the Alpha happens.
  if (frozen.loneWolfSearch)
    locations.set(frozen.loneWolfSearch.playerId, frozen.loneWolfSearch.targetId);
  return locations;
}

function occupantsOf(
  state: GameState,
  locations: Map<UserId, UserId>,
  houseId: UserId,
): PlayerState[] {
  return livingPlayers(state).filter((player) => locations.get(player.id) === houseId);
}

/** Resolve the night's attacks house by house. There are at most two attacks —
 * the pack on the balloted target's house and the serial killer on its visit
 * target — resolved in this exact order:
 *
 *   1. Freeze intents            (freezeNightIntents, before this function)
 *   2. Place everyone in houses  (resolveNightLocations, before this function)
 *   3. Clashes: hunter retaliation, then serial-killer / wolf clash
 *   4. Compute raw hits
 *   5. Priest shield cancels a hit entirely
 *   6. Guardian substitution for any hit that survived the shield
 *   7. Conversions on the hits that remain: Cursed first, then Alpha
 *   8. Cult conversion (not a hit; its own sub-step)
 *   9. Harlot exposure
 *
 * Later roles slot into a named stage instead of being wedged in wherever they
 * fit. Stages 5 and 6 are the only new ones; everything else behaves exactly
 * as it always has. */
function resolveHouseAttacks(
  state: GameState,
  frozen: FrozenNight,
  wolfTargetId: UserId | null,
  locations: Map<UserId, UserId>,
  rng: SeededRng,
  day: number,
): NightOutcome {
  const deaths = new Map<UserId, NightDeathCause>();
  const conversions: { playerId: UserId; cause: ConversionCause }[] = [];
  let ascension: { playerId: UserId } | null = null;
  let loneWolfResult: { playerId: UserId; targetId: UserId; found: boolean } | null = null;

  const attacks: { attacker: "wolves" | "serial_killer"; houseId: UserId }[] = [];
  if (wolfTargetId !== null) attacks.push({ attacker: "wolves", houseId: wolfTargetId });
  if (frozen.serialKillerAction?.type === "visit")
    attacks.push({ attacker: "serial_killer", houseId: frozen.serialKillerAction.targetId });

  // Stage 3: clashes. Hunter retaliation: one independent roll per attacker. A
  // successful roll repels the whole attack — nobody in that house dies — and
  // costs the attacker a life.
  const repelled = new Set<"wolves" | "serial_killer">();
  for (const attack of attacks) {
    const owner = state.players[attack.houseId];
    if (!owner || owner.status !== "alive" || owner.role !== "hunter") continue;
    const scope =
      attack.attacker === "wolves"
        ? `night:${day}:hunter:retaliation:wolves`
        : `night:${day}:hunter:retaliation:serial_killer`;
    if (rng.derive(scope).float() < 0.5) {
      repelled.add(attack.attacker);
      if (attack.attacker === "wolves") {
        const wolves = livingPlayers(state).filter((player) => isPackMember(player));
        if (wolves.length > 0) {
          const wolf = wolves[rng.derive(`night:${day}:hunter:wolf-victim`).int(wolves.length)]!;
          deaths.set(wolf.id, "hunter_retaliation");
        }
      } else {
        deaths.set(frozen.serialKillerAction!.playerId, "hunter_retaliation");
      }
    }
  }

  // Stage 3 (cont.): serial killer / wolf clash: a visiting serial killer that
  // finds a wolf in the same house fights it. The loser dies; the attacks
  // still land.
  if (frozen.serialKillerAction?.type === "visit") {
    const sk = frozen.serialKillerAction.playerId;
    const wolfOccupants = occupantsOf(state, locations, frozen.serialKillerAction.targetId).filter(
      (player) => isPackMember(player),
    );
    if (wolfOccupants.length > 0) {
      if (rng.derive(`night:${day}:serial-killer:clash`).float() < 0.5) {
        const wolf =
          wolfOccupants[
            rng.derive(`night:${day}:serial-killer:clash-victim`).int(wolfOccupants.length)
          ]!;
        deaths.set(wolf.id, "serial_killer_attack");
      } else {
        deaths.set(sk, "wolf_attack");
      }
    }
  }

  // Stage 3 (cont.): the Lone Wolf's duel with the Alpha. A clash happens when
  // the Lone Wolf and a living Alpha Wolf are in the SAME house — the alpha's
  // location equals the house the Lone Wolf searched. The alpha travels with
  // the pack, so this is the house the pack is attacking, or the alpha's own
  // house when the pack stayed home. The loser dies; the clash pre-empts
  // everything else in that house, so neither duellist is later hit by the
  // pack's attack. The Priest's shield does not protect against a duel inside
  // a house. Hunter retaliation above resolves first, as it does for everyone.
  if (frozen.loneWolfSearch) {
    const lw = frozen.loneWolfSearch.playerId;
    const alpha = livingPlayers(state).find((player) => player.role === "alpha_wolf");
    const clash =
      alpha !== undefined &&
      !deaths.has(alpha.id) &&
      !deaths.has(lw) &&
      locations.get(alpha.id) === frozen.loneWolfSearch.targetId;
    if (clash) {
      if (rng.derive(`night:${day}:lone_wolf:challenge`).float() < 0.5) {
        // The Lone Wolf wins: the Alpha dies and the Lone Wolf ascends to take
        // its place.
        deaths.set(alpha!.id, "lone_wolf_clash");
        ascension = { playerId: lw };
      } else {
        deaths.set(lw, "lone_wolf_clash");
      }
    }
    loneWolfResult = { playerId: lw, targetId: frozen.loneWolfSearch.targetId, found: clash };
  }

  // Stage 4: compute raw hits. Each non-repelled attack hits the occupants of
  // its house.
  const hits = new Map<UserId, Set<"wolves" | "serial_killer">>();
  for (const attack of attacks) {
    if (repelled.has(attack.attacker)) continue;
    for (const occupant of occupantsOf(state, locations, attack.houseId)) {
      if (attack.attacker === "wolves") {
        if (isPackMember(occupant)) continue;
        // A visiting serial killer is out hunting, not standing in the house;
        // one attacked at home has no clash and dies normally here.
        if (occupant.role === "serial_killer" && locations.get(occupant.id) !== occupant.id)
          continue;
        // The Lone Wolf's duel with the Alpha was settled in stage 3; when a
        // clash happened, the duellist is not also hit by the pack's attack on
        // that house. The Alpha is already skipped as a pack member.
        if (loneWolfResult?.found && occupant.id === frozen.loneWolfSearch!.playerId) continue;
      } else {
        if (occupant.id === frozen.serialKillerAction!.playerId) continue;
        // Wolves' fate is the clash in stage 3.
        if (isPackMember(occupant)) continue;
      }
      const attackers = hits.get(occupant.id) ?? new Set<"wolves" | "serial_killer">();
      attackers.add(attack.attacker);
      hits.set(occupant.id, attackers);
    }
  }

  // Stage 5: priest shield. A real priest's protection cancels every hit on
  // that player this night, from any attacker, and any conversion it would
  // have caused. "The night did not happen to you."
  const priest = livingPlayers(state).find((player) => player.role === "priest");
  const protectedId = priest ? (frozen.priestProtect?.targetId ?? null) : null;
  if (protectedId !== null) hits.delete(protectedId);

  // Stage 6: guardian substitution. For any hit that survived the shield, if
  // the victim is a real guardian's protegee, the guardian dies instead and
  // the hit is absorbed — so no conversion fires either. One death, one
  // protegee walking away. A dead guardian protects nobody.
  const guardian = livingPlayers(state).find((player) => player.role === "guardian");
  const protegeeId = guardian
    ? ((guardian.roleState as { protegeeId?: UserId | null } | null)?.protegeeId ??
      frozen.guardianBond?.targetId ??
      null)
    : null;
  if (protegeeId !== null && hits.has(protegeeId)) {
    deaths.set(guardian!.id, "guardian_substitution");
    hits.delete(protegeeId);
  }

  // Stage 7: conversions on the hits that remain. The Cursed converts at 100%
  // and must not consume the alpha roll, so it is checked first and unchanged.
  for (const [victimId, attackers] of hits) {
    if (deaths.has(victimId)) continue;
    const victim = state.players[victimId]!;
    if (victim.role === "cursed" && attackers.has("wolves") && !attackers.has("serial_killer")) {
      conversions.push({ playerId: victimId, cause: "cursed" });
      continue;
    }
    // The Alpha Wolf occasionally turns the pack's balloted victim instead of
    // killing them. Only a clean pack kill of the balloted target converts;
    // the Veteran and the Serial Killer are immune (converting them would
    // delete a faction mid-game) and the Seer always dies instead. The cheap
    // conditions are checked before the roll.
    if (
      victimId === wolfTargetId &&
      attackers.has("wolves") &&
      !attackers.has("serial_killer") &&
      livingPlayers(state).some((player) => player.role === "alpha_wolf") &&
      victim.faction === "village" &&
      victim.role !== "seer" &&
      rng.derive(`night:${day}:alpha:conversion`).float() < ALPHA_CONVERSION_CHANCE
    ) {
      conversions.push({ playerId: victimId, cause: "alpha_wolf" });
      continue;
    }
    const cause: NightDeathCause = attackers.has("serial_killer")
      ? "serial_killer_attack"
      : "wolf_attack";
    // A harlot who dies away from her own house was exposed to the encounter.
    if (victim.role === "harlot" && locations.get(victimId) !== victimId)
      deaths.set(victimId, "harlot_exposure");
    else deaths.set(victimId, cause);
  }

  // Stage 7 (cont.): the cult conversion. Not a hit — the leader walks to the
  // target's house and converts them, so it is its own sub-step after the
  // Cursed and Alpha checks. It lands even if the leader is killed that same
  // night. The Guardian does NOT block a conversion: substitution is for a
  // hit, and there is no hit here. The Priest's shield does block it — "the
  // night did not happen to you" — and so does immunity: a wolf, a serial
  // killer and a hunter are all immune. The Veteran is NOT immune: the Cult
  // wins by converting, and denying it the Veteran would gut its core loop.
  if (frozen.cultConvert) {
    const target = state.players[frozen.cultConvert.targetId];
    if (
      target &&
      target.status === "alive" &&
      !deaths.has(target.id) &&
      target.id !== protectedId &&
      !isCultImmune(target)
    ) {
      conversions.push({ playerId: target.id, cause: "cult" });
    }
  }

  // Stage 8: harlot exposure. A harlot who visits a wolf's own house while
  // that wolf is home dies from exposure: the wolf is in, the encounter is
  // fatal. When the pack has a target the wolf is out hunting and the house is
  // empty, so she survives. This is the Harlot dying away from home, not a hit
  // on a house, so neither the shield nor the substitution applies to it.
  if (frozen.harlotAction?.type === "visit") {
    const harlot = frozen.harlotAction.playerId;
    const houseId = frozen.harlotAction.targetId;
    const owner = state.players[houseId];
    if (owner?.faction === "wolves" && locations.get(houseId) === houseId && !deaths.has(harlot))
      deaths.set(harlot, "harlot_exposure");
  }

  // Stage 9: the Alpha's death ends the Lone Wolf's hunt. Ascension is the
  // Lone Wolf's only path to the Alpha's seat, so if the last living Alpha
  // Wolf died this resolution and a Lone Wolf is still alive, the Lone Wolf
  // converts to a plain werewolf and wins with the pack from then on. An
  // ascended Lone Wolf is now the Alpha, so this does not fire for them.
  const livingAlpha = livingPlayers(state).find(
    (player) => player.role === "alpha_wolf" && !deaths.has(player.id),
  );
  const livingLoneWolf = livingPlayers(state).find(
    (player) => player.role === "lone_wolf" && !deaths.has(player.id),
  );
  if (!livingAlpha && !ascension && livingLoneWolf) {
    conversions.push({ playerId: livingLoneWolf.id, cause: "alpha_dead" });
  }

  return { deaths, conversions, ascension, loneWolfResult };
}

function livingPlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((player) => player.status === "alive");
}

/** A player the cult cannot convert. Wolves, the serial killer and the hunter
 * are immune; the Veteran is deliberately NOT — the cult wins by converting,
 * and denying it the Veteran would gut its core loop. */
function isCultImmune(player: PlayerState): boolean {
  return player.faction === "wolves" || player.role === "serial_killer" || player.role === "hunter";
}

function commitNight(outcome: NightOutcome): PlayerPatch[] {
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
function roleStatePatches(state: GameState, frozen: FrozenNight): PlayerPatch[] {
  const patches: PlayerPatch[] = [];
  const priest = livingPlayers(state).find((player) => player.role === "priest");
  if (priest)
    patches.push({
      playerId: priest.id,
      changes: { roleState: { lastProtectedId: frozen.priestProtect?.targetId ?? null } },
    });
  const guardian = livingPlayers(state).find((player) => player.role === "guardian");
  if (guardian && frozen.guardianBond)
    patches.push({
      playerId: guardian.id,
      changes: { roleState: { protegeeId: frozen.guardianBond.targetId } },
    });
  return patches;
}

/** If exactly one member of an established pair is in `deaths` and the other is
 * alive, the other dies too with cause "lover_link". ONE pass only. */
function applyLoverLinkDeaths(state: GameState, deaths: Map<UserId, NightDeathCause>): void {
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
function formLink(
  state: GameState,
  frozen: FrozenNight,
): { patches: PlayerPatch[]; events: DomainTransition["events"] } {
  const patches: PlayerPatch[] = [];
  const events: DomainTransition["events"] = [];
  if (frozen.cupidLink) {
    const cupid = state.players[frozen.cupidLink.playerId];
    if (cupid && isCupidUnlinked(cupid.roleState)) {
      const [a, b] = frozen.cupidLink.targetIds;
      patches.push({ playerId: cupid.id, changes: { roleState: { linked: [a, b] } } });
      events.push(
        { kind: "player.linked", scope: "player", scopeId: a, payload: { partnerId: b } },
        { kind: "player.linked", scope: "player", scopeId: b, payload: { partnerId: a } },
      );
    }
  }
  if (frozen.drunkCupidSelfLink) {
    events.push({
      kind: "player.linked",
      scope: "player",
      scopeId: frozen.drunkCupidSelfLink.playerId,
      payload: { partnerId: frozen.drunkCupidSelfLink.partnerId },
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

function makeNightEvents(
  state: GameState,
  frozen: FrozenNight,
  targetId: UserId | null,
  outcome: NightOutcome,
  seer: FrozenNight["seerInspection"],
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
  if (seer)
    events.push({
      kind: "seer.result",
      scope: "player",
      scopeId: seer.playerId,
      payload: { targetId: seer.targetId, role: seer.role },
    });
  if (frozen.sorcererDivine)
    events.push({
      kind: "sorcerer.result",
      scope: "player",
      scopeId: frozen.sorcererDivine.playerId,
      payload: {
        targetId: frozen.sorcererDivine.targetId,
        isWolf: frozen.sorcererDivine.isWolf,
      },
    });
  if (frozen.drunkFakeResult)
    events.push({
      kind: "seer.result",
      scope: "player",
      scopeId: frozen.drunkFakeResult.playerId,
      payload: {
        targetId: frozen.drunkFakeResult.targetId,
        role: frozen.drunkFakeResult.role,
      },
    });
  // The result is emitted whether or not the investigator survives: they saw
  // what they saw before anything happened to them.
  if (frozen.detectiveInvestigation)
    events.push({
      kind: "detective.result",
      scope: "player",
      scopeId: frozen.detectiveInvestigation.playerId,
      payload: {
        targetId: frozen.detectiveInvestigation.targetId,
        role: frozen.detectiveInvestigation.role,
      },
    });
  if (frozen.drunkFakeDetective)
    events.push({
      kind: "detective.result",
      scope: "player",
      scopeId: frozen.drunkFakeDetective.playerId,
      payload: {
        targetId: frozen.drunkFakeDetective.targetId,
        role: frozen.drunkFakeDetective.role,
      },
    });
  if (frozen.harlotAction) {
    const killed = [...outcome.deaths.keys()].includes(frozen.harlotAction.playerId);
    events.push({
      kind: "harlot.result",
      scope: "player",
      scopeId: frozen.harlotAction.playerId,
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
  events.push({
    kind: "audit.night",
    scope: "server",
    payload: {
      phaseId: state.phase!.id,
      wolfVotes: frozen.wolfVotes,
      wolfTarget: targetId,
      seerInspection: seer ? { targetId: seer.targetId, role: seer.role } : null,
      harlotAction: frozen.harlotAction
        ? frozen.harlotAction.type === "visit"
          ? { type: "visit", targetId: frozen.harlotAction.targetId }
          : { type: "stay" }
        : null,
      serialKillerAction: frozen.serialKillerAction
        ? frozen.serialKillerAction.type === "visit"
          ? { type: "visit", targetId: frozen.serialKillerAction.targetId }
          : { type: "stay" }
        : null,
      deaths: [...outcome.deaths.entries()].map(([playerId, cause]) => ({ playerId, cause })),
      conversions: outcome.conversions.map(({ playerId }) => playerId),
    },
  });
  return events;
}

function applyPatches(state: GameState, patches: PlayerPatch[]): GameState {
  const players = { ...state.players };
  for (const patch of patches)
    players[patch.playerId] = { ...players[patch.playerId]!, ...patch.changes };
  return { ...state, players };
}
