import { isPackMember } from "../../../roles/registry.ts";
import { livingPlayers, type NightContext } from "../context.ts";
import { realIntent } from "../freeze.ts";

// Stage 3: clashes. Hunter retaliation: one independent roll per attacker. A
// successful roll repels the whole attack — nobody in that house dies — and
// costs the attacker a life.
export function hunterRetaliation(context: NightContext): void {
  const { state, frozen, rng, day, attacks, repelled, deaths } = context;
  const serialKillerVisit = realIntent(frozen, "serial_killer.visit");
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
        deaths.set(serialKillerVisit!.actorId, "hunter_retaliation");
      }
    }
  }
}
