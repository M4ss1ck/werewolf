import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

function lastProtectedId(value: unknown): UserId | null {
  if (typeof value !== "object" || value === null || !("lastProtectedId" in value)) return null;
  return (value as { lastProtectedId: UserId | null }).lastProtectedId ?? null;
}

export const priest: RoleDefinition<{ lastProtectedId: UserId | null }> = {
  id: "priest",
  startingFaction: "village",
  createState: () => ({ lastProtectedId: null }),
  composition: { minimumPlayers: 7, drunkMayBelieve: true },
  actions: [
    {
      id: "priest.protect",
      phase: "night",
      // The priest may protect themselves, but never the same player on two
      // consecutive nights.
      target: { kind: "one", pool: "all", excludeSelf: false },
      eligible: ({ player, target }) => target.id !== lastProtectedId(player.roleState),
    },
  ],
};
