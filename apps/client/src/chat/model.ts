import type {
  ChatChannel,
  ChatMention,
  ChatMessage,
  GameEvent,
  GameId,
  UserId,
  ViewerPlayer,
} from "@werewolf/protocol";
import { CHAT_CHANNELS } from "@werewolf/protocol";

export type ClientChatMessage = {
  id: number;
  authorId: UserId;
  displayName: string;
  text: string;
  mentions: ChatMention[];
  createdAt: number;
};

export type ConversationKey = "global" | `game:${GameId}:${ChatChannel}`;

export type ChatDraft = { text: string; mentions: ChatMention[] };

export const EMPTY_CHAT_DRAFT: ChatDraft = { text: "", mentions: [] };

export function globalChatRow(message: ChatMessage): ClientChatMessage {
  return {
    id: message.id,
    authorId: message.userId,
    displayName: message.displayName,
    text: message.text,
    mentions: message.mentions,
    createdAt: message.createdAt,
  };
}

export function gameChatRows(
  events: readonly GameEvent[],
  players: readonly ViewerPlayer[],
): Record<ChatChannel, ClientChatMessage[]> {
  const rows: Record<ChatChannel, ClientChatMessage[]> = {
    public: [],
    wolves: [],
    grave: [],
    cult: [],
  };
  const names = new Map(players.map((player) => [player.userId, player.displayName]));

  for (const event of events) {
    if (event.kind !== "chat.message" || event.actorUserId === undefined) continue;
    rows[event.payload.channel].push({
      id: event.id,
      authorId: event.actorUserId,
      displayName: names.get(event.actorUserId) ?? event.actorUserId,
      text: event.payload.text,
      mentions: event.payload.mentions,
      createdAt: event.createdAt,
    });
  }

  for (const channel of CHAT_CHANNELS) {
    rows[channel].sort((left, right) => left.id - right.id);
  }
  return rows;
}
