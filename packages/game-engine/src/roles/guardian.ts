import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

export const guardian: RoleDefinition<{ protegeeId: UserId | null }> = {
  id: "guardian",
  startingFaction: "village",
  createState: () => ({ protegeeId: null }),
};
