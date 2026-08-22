// The global chat message store. Kept pure and separate from the screen so the
// paging arithmetic Virtuoso depends on can be tested without a DOM.

import type { ChatMessage, ChatMessageId, ChatServerFrame } from "@werewolf/protocol";
import { CHAT_PAGE_SIZE } from "@werewolf/protocol";

/** Virtuoso's `firstItemIndex` counts *down* as older pages are prepended, so
 * it starts high enough that it never reaches zero in practice. */
export const CHAT_FIRST_INDEX = 100_000;
const CHAT_CLIENT_CAP = 1_000;

export type ChatState = {
  messages: ChatMessage[];
  cursor: ChatMessageId;
  oldestRetainedId: ChatMessageId;
  firstItemIndex: number;
  hasOlder: boolean;
  historyTruncated: boolean;
};

export const initialChatState: ChatState = {
  messages: [],
  cursor: 0 as ChatMessageId,
  oldestRetainedId: 0 as ChatMessageId,
  firstItemIndex: CHAT_FIRST_INDEX,
  hasOlder: true,
  historyTruncated: false,
};

type HistoryFrame = Extract<ChatServerFrame, { type: "history" }>;

function mergeMessages(
  state: ChatState,
  incoming: readonly ChatMessage[],
  oldestRetainedId: ChatMessageId,
): { messages: ChatMessage[]; firstItemIndex: number; droppedFront: boolean } {
  const oldLogicalIndex = new Map(
    state.messages.map((message, index) => [message.id, state.firstItemIndex + index]),
  );
  const rows = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of incoming) rows.set(message.id, message);
  const retained = [...rows.values()]
    .filter((message) => oldestRetainedId === 0 || message.id >= oldestRetainedId)
    .sort((left, right) => left.id - right.id);
  const capped = retained.length > CHAT_CLIENT_CAP;
  const messages = capped ? retained.slice(-CHAT_CLIENT_CAP) : retained;
  const overlap = messages.find((message) => oldLogicalIndex.has(message.id));
  const firstItemIndex =
    overlap === undefined
      ? CHAT_FIRST_INDEX
      : oldLogicalIndex.get(overlap.id)! -
        messages.findIndex((message) => message.id === overlap.id);
  return {
    messages,
    firstItemIndex,
    droppedFront: capped,
  };
}

function hasOlderFor(
  state: Pick<ChatState, "messages" | "oldestRetainedId" | "hasOlder">,
): boolean {
  if (state.messages.length === 0) return false;
  if (state.oldestRetainedId > 0) return state.messages[0]!.id > state.oldestRetainedId;
  return state.hasOlder;
}

function nextState(
  state: ChatState,
  incoming: readonly ChatMessage[],
  metadata: {
    cursor: ChatMessageId;
    oldestRetainedId: ChatMessageId;
    hasOlder: boolean;
    historyTruncated: boolean;
    replaceHistoryMetadata?: boolean;
  },
): ChatState {
  const heldIds = new Set(state.messages.map((message) => message.id));
  const overlapsHeld =
    metadata.replaceHistoryMetadata === true && incoming.some((message) => heldIds.has(message.id));
  const retainedFloor = (
    overlapsHeld
      ? Math.max(metadata.oldestRetainedId, state.oldestRetainedId)
      : metadata.oldestRetainedId
  ) as ChatMessageId;
  const merged = mergeMessages(state, incoming, retainedFloor);
  const preserveClientBoundary = overlapsHeld && state.historyTruncated && !state.hasOlder;
  const historyTruncated = metadata.replaceHistoryMetadata
    ? metadata.historyTruncated || preserveClientBoundary || merged.droppedFront
    : state.historyTruncated || metadata.historyTruncated || merged.droppedFront;
  const next: ChatState = {
    ...state,
    messages: merged.messages,
    cursor: Math.max(state.cursor, metadata.cursor) as ChatMessageId,
    oldestRetainedId: retainedFloor,
    firstItemIndex: merged.firstItemIndex,
    hasOlder:
      retainedFloor > 0
        ? hasOlderFor({ ...state, ...merged, oldestRetainedId: retainedFloor })
        : metadata.hasOlder,
    historyTruncated,
  };
  if (merged.droppedFront) {
    next.oldestRetainedId = merged.messages[0]?.id ?? metadata.oldestRetainedId;
    next.hasOlder = false;
  }
  return next;
}

/** A history frame: messages newer than the cursor we subscribed with. On the
 * first one, a short page proves there is nothing older to page back to. */
export function withHistory(state: ChatState, frame: HistoryFrame): ChatState {
  return nextState(state, frame.messages, {
    cursor: frame.cursor,
    oldestRetainedId: frame.oldestRetainedId,
    hasOlder: frame.hasOlder,
    historyTruncated: frame.historyTruncated,
    replaceHistoryMetadata: true,
  });
}

/** A live message. Ignored when the cursor already covers it, which happens
 * when a history frame and a push race on reconnect. */
export function withMessage(state: ChatState, message: ChatMessage): ChatState {
  if (message.id <= state.cursor) return state;
  return nextState(state, [message], {
    cursor: message.id,
    oldestRetainedId: state.oldestRetainedId,
    hasOlder: state.hasOlder,
    historyTruncated: state.historyTruncated,
  });
}

/** An older page, prepended. `firstItemIndex` drops by the page size: that is
 * how Virtuoso tells "older rows arrived" from "the list changed" and holds
 * the viewport still instead of lurching. */
export function withOlderPage(state: ChatState, page: ChatMessage[]): ChatState {
  const next = nextState(state, page, {
    cursor: state.cursor,
    oldestRetainedId: state.oldestRetainedId,
    hasOlder: state.oldestRetainedId > 0 ? state.hasOlder : page.length === CHAT_PAGE_SIZE,
    historyTruncated: state.historyTruncated,
  });
  if (state.oldestRetainedId === 0 && page.length < CHAT_PAGE_SIZE) next.hasOlder = false;
  return next;
}
