import type { UserId } from "@werewolf/protocol";
import type { RoleDefinition } from "./registry.ts";

export const mayor: RoleDefinition<{
  used: boolean;
  overrideDay: number | null;
  overrideTarget: UserId | null;
}> = {
  id: "mayor",
  startingFaction: "village",
  createState: () => ({ used: false, overrideDay: null, overrideTarget: null }),
};
