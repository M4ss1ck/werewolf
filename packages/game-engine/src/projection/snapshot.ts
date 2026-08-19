import type {
  ChatChannel,
  UserId,
  ViewerGameSnapshot,
  ViewerIntent,
  ViewerPlayer,
} from "@werewolf/protocol";
import { getPerceivedRole } from "../roles/perceived.ts";
import { getRoleDefinition, isCultMember, isPackMember } from "../roles/registry.ts";
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
    ...(player.controller?.type === "bot" ? { isBot: true } : {}),
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

function availableChannels(player: PlayerState | undefined): ChatChannel[] {
  if (!player) return ["public"];
  const channels: ChatChannel[] = ["public"];
  // Wolf chat is for the pack and for converted players entitled by marker;
  // a wolf-faction role like the sorcerer must not see the tab it cannot use.
  if (isPackMember(player) || player.channelSince?.wolves !== undefined) channels.push("wolves");
  // Cult chat is for the cult and for converted players entitled by marker.
  if (isCultMember(player) || player.channelSince?.cult !== undefined) channels.push("cult");
  if (player.status === "dead") channels.push("grave");
  return channels;
}

export function projectSnapshot(
  state: GameState,
  viewer: SnapshotViewer | UserId,
  cursor?: number,
  serverNow?: number,
): ViewerGameSnapshot {
  const userId = typeof viewer === "string" ? viewer : viewer.userId;
  const member = state.players[userId];
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
    cursor: (cursor ??
      (typeof viewer === "string" ? 0 : (viewer.cursor ?? 0))) as ViewerGameSnapshot["cursor"],
    serverNow: serverNow ?? (typeof viewer === "string" ? 0 : (viewer.serverNow ?? 0)),
  };

  if (member) {
    const intent = currentIntent(member, state);
    const perceivedRole = getPerceivedRole(member);
    const roleState =
      member.role === "drunk" && perceivedRole !== null
        ? getRoleDefinition(perceivedRole).createState()
        : member.roleState;
    snapshot.me = {
      userId: member.id,
      status: member.status,
      ...(perceivedRole ? { role: perceivedRole } : {}),
      ...(member.faction ? { faction: member.faction } : {}),
      ...(roleState !== undefined ? { roleState } : {}),
      ...(intent !== undefined ? { currentIntent: intent } : {}),
      ...(state.phase &&
      member.phaseState.phaseId === state.phase.id &&
      member.phaseState.ready === true
        ? { ready: true }
        : {}),
    };
  }
  return snapshot;
}
