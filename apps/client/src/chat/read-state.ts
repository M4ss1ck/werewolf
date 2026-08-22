import type { UserId } from "@werewolf/protocol";

import type { ClientChatMessage } from "./model.ts";

export type ConversationReadState = { readThrough: number; seenAfter: number[] };
export type UnreadSummary = {
  ids: number[];
  count: number;
  mentioned: boolean;
};

function validId(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function canonical(state: ConversationReadState): ConversationReadState {
  const readThrough = validId(state.readThrough) ? state.readThrough : 0;
  return {
    readThrough,
    seenAfter: [...new Set(state.seenAfter)]
      .filter((id) => validId(id) && id > readThrough)
      .sort((left, right) => left - right),
  };
}

function collapse(
  state: ConversationReadState,
  messages: readonly ClientChatMessage[],
  viewerId: UserId,
): ConversationReadState {
  const next = canonical(state);
  const seen = new Set(next.seenAfter);
  const rows = [...messages].sort((left, right) => left.id - right.id);
  for (const row of rows) {
    if (row.id <= next.readThrough) continue;
    if (row.authorId === viewerId || seen.has(row.id)) {
      next.readThrough = row.id;
      continue;
    }
    break;
  }
  next.seenAfter = [...seen]
    .filter((id) => id > next.readThrough)
    .sort((left, right) => left - right);
  return next;
}

export function baselineReadState(messages: readonly ClientChatMessage[]): ConversationReadState {
  return {
    readThrough: messages.reduce((latest, message) => Math.max(latest, message.id), 0),
    seenAfter: [],
  };
}

export function markVisible(
  state: ConversationReadState,
  messages: readonly ClientChatMessage[],
  viewerId: UserId,
  visibleIds: readonly number[],
): ConversationReadState {
  const next = canonical(state);
  for (const id of visibleIds) {
    if (validId(id) && id > next.readThrough) next.seenAfter.push(id);
  }
  return collapse(next, messages, viewerId);
}

export function markThrough(state: ConversationReadState, latestId: number): ConversationReadState {
  const next = canonical(state);
  if (validId(latestId) && latestId > next.readThrough) next.readThrough = latestId;
  next.seenAfter = next.seenAfter.filter((id) => id > next.readThrough);
  return next;
}

export function mergeReadState(
  left: ConversationReadState,
  right: ConversationReadState,
  messages: readonly ClientChatMessage[],
  viewerId: UserId,
): ConversationReadState {
  const leftState = canonical(left);
  const rightState = canonical(right);
  return collapse(
    {
      readThrough: Math.max(leftState.readThrough, rightState.readThrough),
      seenAfter: [...leftState.seenAfter, ...rightState.seenAfter],
    },
    messages,
    viewerId,
  );
}

export function rebaseRetainedState(
  state: ConversationReadState,
  messages: readonly ClientChatMessage[],
  viewerId: UserId,
  oldestRetainedId: number,
  latestId: number,
): ConversationReadState {
  if (messages.length === 0 || !validId(latestId) || latestId <= 0) {
    return { readThrough: 0, seenAfter: [] };
  }
  if (!validId(oldestRetainedId)) oldestRetainedId = 0;
  const next = canonical(state);
  if (next.readThrough > latestId) return { readThrough: latestId, seenAfter: [] };
  if (next.readThrough < oldestRetainedId) next.readThrough = Math.max(0, oldestRetainedId - 1);
  next.seenAfter = next.seenAfter.filter((id) => id >= oldestRetainedId && id <= latestId);
  return collapse(next, messages, viewerId);
}

export function unreadSummary(
  state: ConversationReadState,
  messages: readonly ClientChatMessage[],
  viewerId: UserId,
): UnreadSummary {
  const next = canonical(state);
  const seen = new Set(next.seenAfter);
  const unread = [...messages]
    .filter(
      (message) =>
        message.authorId !== viewerId && message.id > next.readThrough && !seen.has(message.id),
    )
    .sort((left, right) => left.id - right.id);
  return {
    ids: unread.map((message) => message.id),
    count: unread.length,
    mentioned: unread.some((message) =>
      message.mentions.some((mention) => mention.userId === viewerId),
    ),
  };
}
