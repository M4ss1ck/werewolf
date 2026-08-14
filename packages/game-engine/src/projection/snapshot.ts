import type { ChatChannel, UserId, ViewerGameSnapshot, ViewerPlayer } from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { getAvailableActions } from "./available-actions.ts";

export interface SnapshotViewer {
  userId: UserId;
  cursor?: number;
  serverNow?: number;
}

function viewerPlayer(player: PlayerState): ViewerPlayer {
  return {
    userId: player.id,
    displayName: player.displayName ?? player.id,
    status: player.status,
    ...(player.status === "dead" && player.role ? { revealedRole: player.role } : {}),
  };
}

function currentIntent(player: PlayerState, state: GameState): unknown {
  if (!state.phase || player.phaseState.phaseId !== state.phase.id) return undefined;
  return {
    ...(player.phaseState.vote ? { vote: player.phaseState.vote } : {}),
    ...(player.phaseState.actions ? { actions: player.phaseState.actions } : {}),
  };
}

function eligiblePlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((player) => player.status === "alive");
}

function hasActed(player: PlayerState, state: GameState): boolean {
  if (!state.phase || player.phaseState.phaseId !== state.phase.id) return false;
  if (state.phase.type === "voting") return player.phaseState.vote !== undefined;
  if (state.phase.type === "night") return Object.keys(player.phaseState.actions ?? {}).length > 0;
  return false;
}

function availableChannels(player: PlayerState | undefined): ChatChannel[] {
  return player && (player.faction === "wolves" || player.wolfSinceEventId !== undefined)
    ? ["public", "wolves"]
    : ["public"];
}

export function projectSnapshot(
  state: GameState,
  viewer: SnapshotViewer | UserId,
  cursor?: number,
  serverNow?: number,
): ViewerGameSnapshot {
  const userId = typeof viewer === "string" ? viewer : viewer.userId;
  const member = state.players[userId];
  const eligible = eligiblePlayers(state);
  const actions = member?.status === "alive" ? getAvailableActions(state, userId) : [];
  const snapshot: ViewerGameSnapshot = {
    game: {
      id: state.id,
      name: state.name ?? state.id,
      ownerUserId: state.ownerUserId,
      status: state.status,
      day: state.day,
      phase: state.phase,
      settings: {
        visibility: state.settings.visibility ?? "public",
        spectatingEnabled: state.settings.spectatingEnabled ?? true,
        durations: {
          discussion: state.settings.discussionDurationMs / 1000,
          voting: state.settings.votingDurationMs / 1000,
          night: state.settings.nightDurationMs / 1000,
        },
      },
    },
    players: Object.values(state.players).map(viewerPlayer),
    availableActions: actions,
    availableChannels: availableChannels(member),
    progress: {
      acted: eligible.filter((player) => hasActed(player, state)).length,
      eligible: eligible.length,
    },
    cursor: (cursor ??
      (typeof viewer === "string" ? 0 : (viewer.cursor ?? 0))) as ViewerGameSnapshot["cursor"],
    serverNow: serverNow ?? (typeof viewer === "string" ? 0 : (viewer.serverNow ?? 0)),
  };

  if (member) {
    snapshot.me = {
      userId: member.id,
      status: member.status,
      ...(member.role ? { role: member.role } : {}),
      ...(member.faction ? { faction: member.faction } : {}),
      ...(member.roleState !== undefined ? { roleState: member.roleState } : {}),
      ...(currentIntent(member, state) !== undefined
        ? { currentIntent: currentIntent(member, state) }
        : {}),
    };
  }
  return snapshot;
}
