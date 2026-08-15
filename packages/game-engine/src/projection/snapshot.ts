import type {
  ChatChannel,
  UserId,
  ViewerGameSnapshot,
  ViewerIntent,
  ViewerPlayer,
} from "@werewolf/protocol";
import type { GameState, PlayerState } from "../state.ts";
import { getAvailableActions } from "./available-actions.ts";

export interface SnapshotViewer {
  userId: UserId;
  cursor?: number;
  serverNow?: number;
}

function viewerPlayer(player: PlayerState, finished: boolean): ViewerPlayer {
  return {
    userId: player.id,
    displayName: player.displayName ?? player.id,
    status: player.status,
    ...((player.status === "dead" || finished) && player.role ? { revealedRole: player.role } : {}),
  };
}

function currentIntent(player: PlayerState, state: GameState): ViewerIntent | undefined {
  if (!state.phase || player.phaseState.phaseId !== state.phase.id) return undefined;
  return {
    ...(player.phaseState.vote ? { vote: player.phaseState.vote } : {}),
    ...(player.phaseState.actions ? { actions: player.phaseState.actions } : {}),
  };
}

/** Aggregate per-target vote counts for the live voting phase. Voter identities
 * are deliberately absent: a count is all the client is ever allowed to see. */
function voteTallies(state: GameState): { targetId: UserId; count: number }[] | undefined {
  if (!state.phase || state.phase.type !== "voting") return undefined;
  const tally = new Map<UserId, number>();
  for (const player of Object.values(state.players)) {
    if (player.status !== "alive") continue;
    if (player.phaseState.phaseId !== state.phase.id) continue;
    const vote = player.phaseState.vote;
    if (vote?.type !== "player") continue;
    tally.set(vote.targetId, (tally.get(vote.targetId) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([targetId, count]) => ({ targetId, count }))
    .sort(
      (a, b) =>
        b.count - a.count || (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0),
    );
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
  const tallies = voteTallies(state);
  const snapshot: ViewerGameSnapshot = {
    game: {
      id: state.id,
      name: state.name ?? state.id,
      ownerUserId: state.ownerUserId,
      status: state.status,
      ...(state.scheduledAt ? { scheduledAt: state.scheduledAt } : {}),
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
      ...(state.status === "finished" && state.winner ? { winner: state.winner } : {}),
    },
    players: Object.values(state.players).map((player) =>
      viewerPlayer(player, state.status === "finished"),
    ),
    ...(tallies ? { voteTallies: tallies } : {}),
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
    const intent = currentIntent(member, state);
    snapshot.me = {
      userId: member.id,
      status: member.status,
      ...(member.role ? { role: member.role } : {}),
      ...(member.faction ? { faction: member.faction } : {}),
      ...(member.roleState !== undefined ? { roleState: member.roleState } : {}),
      ...(intent !== undefined ? { currentIntent: intent } : {}),
    };
  }
  return snapshot;
}
