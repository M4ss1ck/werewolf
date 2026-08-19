import type { RoleDefinition } from "./registry.ts";
export interface PrincessState {
  lynchProtectionUsed: boolean;
}
export const princess: RoleDefinition<PrincessState> = {
  id: "princess",
  startingFaction: "village",
  createState: () => ({ lynchProtectionUsed: false }),
  composition: {},
  onDaySelected: ({ state }) =>
    state.lynchProtectionUsed
      ? []
      : [
          { type: "survive" },
          { type: "reveal" },
          { type: "setState", value: { lynchProtectionUsed: true } },
        ],
};
