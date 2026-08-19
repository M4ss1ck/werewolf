import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

function isGuardianBonded(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "protegeeId" in value &&
    (value as { protegeeId: unknown }).protegeeId !== null
  );
}

export const guardian: RoleDefinition<{ protegeeId: UserId | null }> = {
  id: "guardian",
  startingFaction: "village",
  createState: () => ({ protegeeId: null }),
  composition: { minimumPlayers: 7, drunkMayBelieve: true },
  actions: [
    {
      id: "guardian.bond",
      phase: "night",
      // The guardian bonds once, on the first night, to any living player but
      // themselves.
      target: { kind: "one", pool: "all", excludeSelf: true },
      available: ({ player, state }) => state.day === 1 && !isGuardianBonded(player.roleState),
    },
  ],
};
