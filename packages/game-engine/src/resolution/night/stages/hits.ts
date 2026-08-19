import { isPackMember } from "../../../roles/registry.ts";
import { type NightContext, occupantsOf } from "../context.ts";
import { realIntent } from "../freeze.ts";

export function planAttacks(context: NightContext): void {
  const { frozen, wolfTargetId } = context;
  const serialKillerVisit = realIntent(frozen, "serial_killer.visit");
  if (wolfTargetId !== null) context.attacks.push({ attacker: "wolves", houseId: wolfTargetId });
  if (serialKillerVisit)
    context.attacks.push({ attacker: "serial_killer", houseId: serialKillerVisit.targetId! });
}

// Stage 4: compute raw hits. Each non-repelled attack hits the occupants of
// its house.
export function computeHits(context: NightContext): void {
  const { state, frozen, locations, attacks, repelled, hits, loneWolfResult } = context;
  const serialKillerVisit = realIntent(frozen, "serial_killer.visit");
  const loneWolfSearch = realIntent(frozen, "lone_wolf.search");
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
        if (loneWolfResult?.found && occupant.id === loneWolfSearch!.actorId) continue;
      } else {
        if (occupant.id === serialKillerVisit!.actorId) continue;
        // Wolves' fate is the clash in stage 3.
        if (isPackMember(occupant)) continue;
      }
      const attackers = hits.get(occupant.id) ?? new Set<"wolves" | "serial_killer">();
      attackers.add(attack.attacker);
      hits.set(occupant.id, attackers);
    }
  }
}
