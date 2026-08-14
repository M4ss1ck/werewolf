// The viewer-specific projection of a game. The client never receives the full
// authoritative state, only what this snapshot carries, filtered for one
// viewer: no hidden role composition, no other players' roles, no audit data.

import type { AvailableAction } from "./actions.ts";
import type {
  ChatChannel,
  FactionId,
  GamePhase,
  GamePlayerStatus,
  GameStatus,
  GameVisibility,
  RoleId,
} from "./enums.ts";
import type { EventId, GameId, PhaseId, UserId } from "./ids.ts";

export interface ViewerGameSettings {
  visibility: GameVisibility;
  /** Whether spectators are allowed after the game starts. */
  spectatingEnabled: boolean;
  /** Phase durations in seconds. */
  durations: {
    discussion: number;
    voting: number;
    night: number;
  };
}

export interface ViewerPlayer {
  userId: UserId;
  displayName: string;
  status: GamePlayerStatus;
  /** Present only for dead players, whose current role is public. */
  revealedRole?: RoleId;
}

export interface ViewerGameSnapshot {
  game: {
    id: GameId;
    name: string;
    status: GameStatus;
    day: number;
    phase: {
      id: PhaseId;
      type: GamePhase;
      startedAt: number;
      endsAt: number;
    } | null;
    settings: ViewerGameSettings;
  };
  players: ViewerPlayer[];
  /** Present only when the viewer is a member of the game. */
  me?: {
    userId: UserId;
    status: GamePlayerStatus;
    role?: RoleId;
    faction?: FactionId;
    roleState?: unknown;
    currentIntent?: unknown;
  };
  availableActions: AvailableAction[];
  availableChannels: ChatChannel[];
  progress?: {
    acted: number;
    eligible: number;
  };
  cursor: EventId;
  serverNow: number;
}
