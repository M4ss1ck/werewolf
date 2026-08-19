import type { RoleId } from "@werewolf/protocol";
import type { PlayerState } from "../state.ts";

function isDrunkState(value: unknown): value is { perceivedRole: RoleId | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "perceivedRole" in value &&
    (typeof (value as { perceivedRole: unknown }).perceivedRole === "string" ||
      (value as { perceivedRole: unknown }).perceivedRole === null)
  );
}

/** What a player believes their role is. Identical to the real role for
 * everyone except the Drunk, who is told they are something else. Every
 * player-facing decision - which actions are offered, which commands are
 * legal, what the role card says - keys on THIS, never on `role`. The true
 * role is what resolution and death reveal key on. */
export function getPerceivedRole(player: PlayerState): RoleId | null {
  if (
    player.role === "drunk" &&
    isDrunkState(player.roleState) &&
    player.roleState.perceivedRole !== null
  ) {
    return player.roleState.perceivedRole;
  }
  return player.role;
}
