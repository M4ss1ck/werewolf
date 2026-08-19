import { livingPlayers, type NightContext } from "../context.ts";
import { realIntent } from "../freeze.ts";

// Stage 5: priest shield. A real priest's protection cancels every hit on
// that player this night, from any attacker, and any conversion it would
// have caused. "The night did not happen to you."
export function priestShield(context: NightContext): void {
  const { state, frozen, hits } = context;
  const priest = livingPlayers(state).find((player) => player.role === "priest");
  const priestProtect = realIntent(frozen, "priest.protect");
  const protectedId = priest ? (priestProtect?.targetId ?? null) : null;
  context.protectedId = protectedId;
  if (protectedId !== null) hits.delete(protectedId);
}
