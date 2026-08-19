import type { NightDeathCause } from "@werewolf/protocol";
import { ALPHA_CONVERSION_CHANCE } from "../../../composer/balance-v1.ts";
import { isCultImmune, livingPlayers, type NightContext } from "../context.ts";
import { realIntent } from "../freeze.ts";

// Stage 7: conversions on the hits that remain. The Cursed converts at 100%
// and must not consume the alpha roll, so it is checked first and unchanged.
export function applyConversions(context: NightContext): void {
  const {
    state,
    frozen,
    locations,
    rng,
    day,
    hits,
    deaths,
    conversions,
    wolfTargetId,
    protectedId,
  } = context;
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
  const cultConvert = realIntent(frozen, "cult.convert");
  if (cultConvert) {
    const target = state.players[cultConvert.targetId!];
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
}
