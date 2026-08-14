// The server drives gameplay legality: the client renders controls from this
// model instead of switching on its own knowledge of roles.

import type { ActionId } from "./enums.ts";
import type { UserId } from "./ids.ts";

export interface AvailableTargetAction {
  id: ActionId;
  type: "target";
  targets: {
    userId: UserId;
    enabled: boolean;
  }[];
  selectedTargetId?: UserId;
}

/** A targetless option the player may pick, e.g. the Harlot staying home. */
export interface AvailableChoiceAction {
  id: ActionId;
  type: "choice";
  /** Whether this targetless action is currently selected. */
  selected?: boolean;
}

/** Union of action models; more shapes may join it later. */
export type AvailableAction = AvailableTargetAction | AvailableChoiceAction;
