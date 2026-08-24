import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

function isMayorState(value: unknown): value is { used: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "used" in value &&
    typeof (value as { used: unknown }).used === "boolean"
  );
}

export const mayor: RoleDefinition<{
  used: boolean;
  overrideDay: number | null;
  overrideTarget: UserId | null;
}> = {
  id: "mayor",
  startingFaction: "village",
  createState: () => ({ used: false, overrideDay: null, overrideTarget: null }),
  composition: { minimumPlayers: 8 },
  contests: ({ roleState }) => isMayorState(roleState) && !roleState.used,
  actions: [
    {
      id: "mayor.reveal",
      phase: "day",
      target: { kind: "one", pool: "others", excludeSelf: true },
      available: ({ player }) => isMayorState(player.roleState) && !player.roleState.used,
    },
    {
      id: "mayor.pardon",
      phase: "day",
      target: null,
      available: ({ player }) => isMayorState(player.roleState) && !player.roleState.used,
    },
  ],
};
