// The global chat message store. Kept pure and separate from the screen so the
// paging arithmetic Virtuoso depends on can be tested without a DOM — jsdom
// performs no layout, so the virtualized list itself cannot be tested there.

import type { ChatMessage, ChatMessageId } from "@werewolf/protocol";
import { CHAT_PAGE_SIZE } from "@werewolf/protocol";

/** Virtuoso's `firstItemIndex` counts *down* as older pages are prepended, so
 * it starts high enough that it never reaches zero in practice. */
export const CHAT_FIRST_INDEX = 100_000;

export type ChatState = {
  messages: ChatMessage[];
  cursor: ChatMessageId;
  firstItemIndex: number;
  hasOlder: boolean;
};

export const initialChatState: ChatState = {
  messages: [],
  cursor: 0 as ChatMessageId,
  firstItemIndex: CHAT_FIRST_INDEX,
  hasOlder: true,
};

/** A history frame: messages newer than the cursor we subscribed with. On the
 * first one, a short page proves there is nothing older to page back to. */
export function withHistory(
  state: ChatState,
  messages: ChatMessage[],
  cursor: ChatMessageId,
): ChatState {
  const first = state.messages.length === 0;
  if (!first && messages.length === CHAT_PAGE_SIZE) {
    // A full page onto a non-empty state may have been truncated by the
    // server's page cap, so it cannot be trusted contiguous with what we
    // already hold. Treat it as a cold open rather than risk a silent gap.
    return {
      ...state,
      messages,
      cursor,
      firstItemIndex: CHAT_FIRST_INDEX,
      hasOlder: true,
    };
  }
  return {
    ...state,
    messages: [...state.messages, ...messages],
    cursor,
    hasOlder: first ? messages.length === CHAT_PAGE_SIZE : state.hasOlder,
  };
}

/** A live message. Ignored when the cursor already covers it, which happens
 * when a history frame and a push race on reconnect. */
export function withMessage(state: ChatState, message: ChatMessage): ChatState {
  if (message.id <= state.cursor) return state;
  return {
    ...state,
    messages: [...state.messages, message],
    cursor: message.id,
  };
}

/** An older page, prepended. `firstItemIndex` drops by the page size: that is
 * how Virtuoso tells "older rows arrived" from "the list changed" and holds
 * the viewport still instead of lurching. */
export function withOlderPage(state: ChatState, page: ChatMessage[]): ChatState {
  return {
    ...state,
    messages: [...page, ...state.messages],
    firstItemIndex: state.firstItemIndex - page.length,
    hasOlder: page.length === CHAT_PAGE_SIZE,
  };
}
