import type { RoleId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

export const drunk: RoleDefinition<{ perceivedRole: RoleId | null }> = {
  id: "drunk",
  startingFaction: "village",
  createState: () => ({ perceivedRole: null }),
};
