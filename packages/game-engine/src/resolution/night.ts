import type { ConversionCause, NightDeathCause, RoleId, UserId } from "@werewolf/protocol";
import { ALPHA_CONVERSION_CHANCE } from "../composer/balance-v1.ts";
import type { SeededRng } from "../rng/rng.ts";
import type {
  DomainResult,
  DomainTransition,
  GameState,
  PlayerPatch,
  PlayerState,
} from "../state.ts";
import { checkVictory } from "./victory.ts";

export interface NightResolutionContext {
  now: number;
  rng: SeededRng;
}

type FrozenNight = {
  wolfVotes: { playerId: UserId; targetId: UserId | null }[];
  seerInspection: { playerId: UserId; targetId: UserId; role: RoleId } | null;
  harlotAction:
    | { playerId: UserId; type: "stay" }
    | { playerId: UserId; type: "visit"; targetId: UserId }
    | null;
  serialKillerAction:
    | { playerId: UserId; type: "stay" }
    | { playerId: UserId; type: "visit"; targetId: UserId }
    | null;
};

type NightOutcome = {
  deaths: Map<UserId, NightDeathCause>;
  conversions: { playerId: UserId; cause: ConversionCause }[];
};

export function resolveNight(state: GameState, context: NightResolutionContext): DomainResult {
  if (!state.phase || state.phase.type !== "night")
    return { ok: false, error: { code: "ACTION_NOT_AVAILABLE" } };
  const frozen = freezeNightIntents(state);
  const seer = frozen.seerInspection;
  const targetId = resolveWolfBallot(frozen.wolfVotes);
  const locations = resolveNightLocations(state, frozen, targetId);
  const outcome = resolveHouseAttacks(state, frozen, targetId, locations, context.rng, state.day);
  const playerPatches = commitNight(outcome);
  const projected = applyPatches(state, playerPatches);
  const events = makeNightEvents(state, frozen, targetId, outcome, seer);
  const winner = checkVictory(projected);
  if (winner) {
    events.push({ kind: "game.finished", scope: "public", payload: winner });
    return {
      ok: true,
      transition: {
        gamePatch: { status: "finished", winner },
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
      gamePatch: { day: state.day + 1, phase: nextPhase },
      playerPatches,
      events,
      ephemeral: [],
    },
  };
}

function freezeNightIntents(state: GameState): FrozenNight {
  const phaseId = state.phase!.id;
  const living = Object.values(state.players).filter((player) => player.status === "alive");
  const wolfVotes = living
    .filter((player) => player.faction === "wolves")
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
  return { wolfVotes, seerInspection, harlotAction, serialKillerAction };
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
 * of the player whose house they are in. Everyone starts at home; the wolves
 * gather at the balloted target's house (or stay home on a tie or empty
 * ballot), and the harlot and serial killer travel to their visit targets.
 * The seer never travels: scrying is remote. */
function resolveNightLocations(
  state: GameState,
  frozen: FrozenNight,
  wolfTargetId: UserId | null,
): Map<UserId, UserId> {
  const locations = new Map<UserId, UserId>();
  for (const player of livingPlayers(state)) locations.set(player.id, player.id);
  if (wolfTargetId !== null) {
    for (const player of livingPlayers(state)) {
      if (player.faction === "wolves") locations.set(player.id, wolfTargetId);
    }
  }
  if (frozen.harlotAction?.type === "visit")
    locations.set(frozen.harlotAction.playerId, frozen.harlotAction.targetId);
  if (frozen.serialKillerAction?.type === "visit")
    locations.set(frozen.serialKillerAction.playerId, frozen.serialKillerAction.targetId);
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
 * target — resolved in this exact order: hunter retaliation, serial-killer /
 * wolf clash, then the kills themselves. */
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

  const attacks: { attacker: "wolves" | "serial_killer"; houseId: UserId }[] = [];
  if (wolfTargetId !== null) attacks.push({ attacker: "wolves", houseId: wolfTargetId });
  if (frozen.serialKillerAction?.type === "visit")
    attacks.push({ attacker: "serial_killer", houseId: frozen.serialKillerAction.targetId });

  // (a) Hunter retaliation: one independent roll per attacker. A successful
  // roll repels the whole attack — nobody in that house dies — and costs the
  // attacker a life.
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
        const wolves = livingPlayers(state).filter((player) => player.faction === "wolves");
        if (wolves.length > 0) {
          const wolf = wolves[rng.derive(`night:${day}:hunter:wolf-victim`).int(wolves.length)]!;
          deaths.set(wolf.id, "hunter_retaliation");
        }
      } else {
        deaths.set(frozen.serialKillerAction!.playerId, "hunter_retaliation");
      }
    }
  }

  // (b) Serial killer / wolf clash: a visiting serial killer that finds a wolf
  // in the same house fights it. The loser dies; the attacks still land.
  if (frozen.serialKillerAction?.type === "visit") {
    const sk = frozen.serialKillerAction.playerId;
    const wolfOccupants = occupantsOf(state, locations, frozen.serialKillerAction.targetId).filter(
      (player) => player.faction === "wolves",
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

  // (c) Kills: each non-repelled attack hits the occupants of its house.
  const hits = new Map<UserId, Set<"wolves" | "serial_killer">>();
  for (const attack of attacks) {
    if (repelled.has(attack.attacker)) continue;
    for (const occupant of occupantsOf(state, locations, attack.houseId)) {
      if (attack.attacker === "wolves") {
        if (occupant.faction === "wolves") continue;
        // A visiting serial killer is out hunting, not standing in the house;
        // one attacked at home has no clash and dies normally here.
        if (occupant.role === "serial_killer" && locations.get(occupant.id) !== occupant.id)
          continue;
      } else {
        if (occupant.id === frozen.serialKillerAction!.playerId) continue;
        // Wolves' fate is the clash in step (b).
        if (occupant.faction === "wolves") continue;
      }
      const attackers = hits.get(occupant.id) ?? new Set<"wolves" | "serial_killer">();
      attackers.add(attack.attacker);
      hits.set(occupant.id, attackers);
    }
  }
  for (const [victimId, attackers] of hits) {
    if (deaths.has(victimId)) continue;
    const victim = state.players[victimId]!;
    // The Cursed converts at 100% and must not consume the alpha roll, so it
    // is checked first and unchanged.
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

  // A harlot who visits a wolf's own house while that wolf is home dies from
  // exposure: the wolf is in, the encounter is fatal. When the pack has a
  // target the wolf is out hunting and the house is empty, so she survives.
  if (frozen.harlotAction?.type === "visit") {
    const harlot = frozen.harlotAction.playerId;
    const houseId = frozen.harlotAction.targetId;
    const owner = state.players[houseId];
    if (owner?.faction === "wolves" && locations.get(houseId) === houseId && !deaths.has(harlot))
      deaths.set(harlot, "harlot_exposure");
  }

  return { deaths, conversions };
}

function livingPlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((player) => player.status === "alive");
}

function commitNight(outcome: NightOutcome): PlayerPatch[] {
  const patches: PlayerPatch[] = [];
  for (const [playerId] of outcome.deaths) patches.push({ playerId, changes: { status: "dead" } });
  for (const { playerId } of outcome.conversions)
    patches.push({ playerId, changes: { role: "werewolf", faction: "wolves" } });
  return patches;
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
  if (frozen.harlotAction) {
    const killed = [...outcome.deaths.keys()].includes(frozen.harlotAction.playerId);
    events.push({
      kind: "harlot.result",
      scope: "player",
      scopeId: frozen.harlotAction.playerId,
      payload: { outcome: killed ? "killed" : "safe" },
    });
  }
  for (const { playerId, cause } of outcome.conversions) {
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
