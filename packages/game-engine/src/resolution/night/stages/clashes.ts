import { isPackMember } from "../../../roles/registry.ts";
import { livingPlayers, type NightContext, occupantsOf } from "../context.ts";
import { realIntent } from "../freeze.ts";

// Stage 3 (cont.): serial killer / wolf clash: a visiting serial killer that
// finds a wolf in the same house fights it. The loser dies; the attacks
// still land.
export function serialKillerClash(context: NightContext): void {
  const { state, frozen, locations, rng, day, deaths } = context;
  const serialKillerVisit = realIntent(frozen, "serial_killer.visit");
  if (serialKillerVisit) {
    const sk = serialKillerVisit.actorId;
    const wolfOccupants = occupantsOf(state, locations, serialKillerVisit.targetId!).filter(
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
}

// Stage 3 (cont.): the Lone Wolf's duel with the Alpha. A clash happens when
// the Lone Wolf and a living Alpha Wolf are in the SAME house — the alpha's
// location equals the house the Lone Wolf searched. The alpha travels with
// the pack, so this is the house the pack is attacking, or the alpha's own
// house when the pack stayed home. The loser dies; the clash pre-empts
// everything else in that house, so neither duellist is later hit by the
// pack's attack. The Priest's shield does not protect against a duel inside
// a house. Hunter retaliation above resolves first, as it does for everyone.
export function loneWolfDuel(context: NightContext): void {
  const { state, frozen, locations, rng, day, deaths } = context;
  const loneWolfSearch = realIntent(frozen, "lone_wolf.search");
  if (loneWolfSearch) {
    const lw = loneWolfSearch.actorId;
    const alpha = livingPlayers(state).find((player) => player.role === "alpha_wolf");
    const clash =
      alpha !== undefined &&
      !deaths.has(alpha.id) &&
      !deaths.has(lw) &&
      locations.get(alpha.id) === loneWolfSearch.targetId;
    if (clash) {
      if (rng.derive(`night:${day}:lone_wolf:challenge`).float() < 0.5) {
        // The Lone Wolf wins: the Alpha dies and the Lone Wolf ascends to take
        // its place.
        deaths.set(alpha!.id, "lone_wolf_clash");
        context.ascension = { playerId: lw };
      } else {
        deaths.set(lw, "lone_wolf_clash");
      }
    }
    context.loneWolfResult = { playerId: lw, targetId: loneWolfSearch.targetId!, found: clash };
  }
}
