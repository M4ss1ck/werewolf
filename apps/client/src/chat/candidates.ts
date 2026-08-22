import type { ChatChannel, UserId, ViewerGameSnapshot, ViewerPlayer } from "@werewolf/protocol";

import type { MentionCandidate } from "./mentions.ts";

function candidate(player: ViewerPlayer): MentionCandidate {
  return {
    userId: player.userId,
    displayName: player.displayName,
    ...(player.status === undefined ? {} : { status: player.status }),
    ...(player.isBot === undefined ? {} : { isBot: player.isBot }),
  };
}

function sortCandidates(players: ViewerPlayer[]): MentionCandidate[] {
  return players
    .sort((left, right) => (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0))
    .map(candidate);
}

/** Derive the mention roster from the viewer projection; missing projected
 * knowledge is deliberately treated as no candidates. */
export function gameMentionCandidates(
  snapshot: ViewerGameSnapshot,
  channel: ChatChannel,
): MentionCandidate[] {
  const viewerId = snapshot.me?.userId;
  if (viewerId === undefined || !snapshot.availableChannels.includes(channel)) return [];
  const players = snapshot.players.filter((player) => player.userId !== viewerId);

  if (channel === "public") {
    return sortCandidates(
      players.filter((player) => player.status === "alive" || player.status === "dead"),
    );
  }
  if (channel === "grave") {
    return sortCandidates(players.filter((player) => player.status === "dead"));
  }

  const knownIds = snapshot.knownChannelMemberIds?.[channel];
  if (knownIds === undefined) return [];
  const known = new Set<UserId>(knownIds);
  return sortCandidates(
    players.filter(
      (player) =>
        known.has(player.userId) && (player.status === "alive" || player.status === "dead"),
    ),
  );
}
