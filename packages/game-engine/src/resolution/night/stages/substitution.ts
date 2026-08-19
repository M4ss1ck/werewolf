import type { UserId } from "@werewolf/protocol";
import { livingPlayers, type NightContext } from "../context.ts";
import { realIntent } from "../freeze.ts";

// Stage 6: guardian substitution. For any hit that survived the shield, if
// the victim is a real guardian's protegee, the guardian dies instead and
// the hit is absorbed — so no conversion fires either. One death, one
// protegee walking away. A dead guardian protects nobody.
export function guardianSubstitution(context: NightContext): void {
  const { state, frozen, hits, deaths } = context;
  const guardian = livingPlayers(state).find((player) => player.role === "guardian");
  const guardianBond = realIntent(frozen, "guardian.bond");
  const protegeeId = guardian
    ? ((guardian.roleState as { protegeeId?: UserId | null } | null)?.protegeeId ??
      guardianBond?.targetId ??
      null)
    : null;
  if (protegeeId !== null && hits.has(protegeeId)) {
    deaths.set(guardian!.id, "guardian_substitution");
    hits.delete(protegeeId);
  }
}
