import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatContent, ChatMessage, ChatMessageId, UserId } from "@werewolf/protocol";
import type { ComponentProps, ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { expect, test, vi } from "vitest";
import type { ChatViewportSnapshot, MentionCandidate } from "../chat/index.ts";
import type { ChatDraft } from "../chat/model.ts";
import type { ConversationReadState } from "../chat/read-state.ts";

vi.mock("../chat/index.ts", () => ({
  ChatList: ({
    messages,
    hasOlder,
    onLoadOlder,
    firstItemIndex,
    historyTruncated,
    identityCohort,
    jumpToLatestToken,
    onVisible,
    onMarkThrough,
    onSnapshot,
    readState,
    snapshot,
  }: {
    messages: { id: number; text: string }[];
    hasOlder: boolean;
    onLoadOlder: () => void;
    firstItemIndex: number;
    historyTruncated?: boolean;
    identityCohort: MentionCandidate[];
    jumpToLatestToken: number;
    onVisible: (ids: number[]) => void;
    onMarkThrough: (latestId: number) => void;
    onSnapshot: (snapshot: ChatViewportSnapshot) => void;
    readState: ConversationReadState;
    snapshot?: ChatViewportSnapshot;
  }) => (
    <section
      aria-label="chat list"
      data-cohort={identityCohort.map((candidate) => candidate.userId).join(",")}
      data-first-index={firstItemIndex}
      data-first-unread={
        messages.find(
          (message) =>
            message.id > readState.readThrough && !readState.seenAfter.includes(message.id),
        )?.id
      }
      data-jump-token={jumpToLatestToken}
      data-read-through={readState.readThrough}
      data-snapshot={snapshot === undefined ? "absent" : JSON.stringify(snapshot)}
      data-truncated={String(historyTruncated ?? false)}
    >
      {messages.length === 0 ? <p>No messages yet. Say hello.</p> : null}
      {messages.map((message) => (
        <p key={message.id}>{message.text}</p>
      ))}
      {messages[0] !== undefined && (
        <button onClick={() => onVisible([messages[0]!.id])} type="button">
          visible
        </button>
      )}
      {messages.at(-1) !== undefined && (
        <button onClick={() => onMarkThrough(messages.at(-1)!.id)} type="button">
          mark-through
        </button>
      )}
      <button
        onClick={() =>
          onSnapshot({
            virtuoso: { ranges: [], scrollTop: 0 },
            messageIds: messages.map((message) => message.id),
            anchorId: messages[0]?.id ?? 0,
            anchorOffset: 0,
          })
        }
        type="button"
      >
        snapshot
      </button>
      {hasOlder && (
        <button onClick={onLoadOlder} type="button">
          start-reached
        </button>
      )}
    </section>
  ),
  ChatComposer: ({
    draft,
    error,
    onDraftChange,
    onError,
    onInvalidMention,
    onSend,
    onSent,
  }: {
    draft: ChatDraft;
    error?: unknown;
    onDraftChange: (draft: ChatDraft) => void;
    onError: (error: unknown) => void;
    onInvalidMention: () => void;
    onSend: (content: ChatContent) => Promise<void>;
    onSent: () => void;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSend(draft)
          .then(() => {
            onDraftChange({ text: "", mentions: [] });
            onSent();
          })
          .catch(onError);
      }}
    >
      <label htmlFor="global-chat-message">Message</label>
      <input
        id="global-chat-message"
        onChange={(event) => onDraftChange({ text: event.target.value, mentions: [] })}
        value={draft.text}
      />
      <button aria-label="Send message" type="submit">
        send
      </button>
      <button onClick={onInvalidMention} type="button">
        invalid-mention
      </button>
      {error ? <p role="alert">{String((error as { code?: string }).code ?? error)}</p> : null}
    </form>
  ),
}));

const { GlobalChatScreen } = await import("./global-chat.tsx");
const { initialChatState, withHistory } = await import("../api/chat-state.ts");
const { i18n } = await import("../i18n/i18n.ts");

function message(id: number, text: string, userId = "u1"): ChatMessage {
  return {
    id: id as ChatMessageId,
    userId: userId as UserId,
    displayName: "Ana",
    text,
    mentions: [],
    createdAt: 1_000_000 + id,
  };
}

function stateWith(...messages: ChatMessage[]) {
  return withHistory(initialChatState, {
    type: "history",
    messages,
    cursor: (messages.at(-1)?.id ?? 0) as ChatMessageId,
    oldestRetainedId: (messages[0]?.id ?? 0) as ChatMessageId,
    hasOlder: false,
    historyTruncated: false,
  });
}

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function props(overrides: Partial<ComponentProps<typeof GlobalChatScreen>> = {}) {
  return {
    candidates: [],
    draft: { text: "", mentions: [] },
    jumpToLatestToken: 0,
    mentionSource: {
      kind: "remote" as const,
      search: async () => [],
      recentUserIds: [],
      refreshToken: 0,
    },
    onDraftChange: () => undefined,
    onError: () => undefined,
    onInvalidMention: () => undefined,
    onLoadOlder: () => undefined,
    onMarkThrough: () => undefined,
    onSend: async () => undefined,
    onSent: () => undefined,
    onSnapshot: () => undefined,
    onVisible: () => undefined,
    readState: { readThrough: 0, seenAfter: [] },
    state: initialChatState,
    viewerId: "u2" as UserId,
    ...overrides,
  };
}

test("renders the messages it is given", () => {
  renderWithI18n(
    <GlobalChatScreen
      {...props({ state: stateWith(message(1, "hello"), message(2, "I'm in")) })}
    />,
  );

  expect(screen.getByText("hello")).toBeInTheDocument();
  expect(screen.getByText("I'm in")).toBeInTheDocument();
});

test("shows the empty state when there are no messages", () => {
  renderWithI18n(<GlobalChatScreen {...props()} />);
  expect(screen.getByText("No messages yet. Say hello.")).toBeInTheDocument();
});

test("sending a message supplies structured content and the controlled draft can clear", async () => {
  let draft: ChatDraft = { text: "", mentions: [] };
  const sent: ChatContent[] = [];
  const view = renderWithI18n(
    <GlobalChatScreen
      {...props({
        draft,
        onDraftChange: (next) => {
          draft = next;
          view.rerender(
            <I18nextProvider i18n={i18n}>
              <GlobalChatScreen
                {...props({
                  draft,
                  onDraftChange: (next) => {
                    draft = next;
                  },
                  onSend: async (content) => {
                    sent.push(content);
                  },
                })}
              />
            </I18nextProvider>,
          );
        },
        onSend: async (content) => {
          sent.push(content);
        },
      })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
  fireEvent.submit(screen.getByLabelText("Message").closest("form")!);

  await vi.waitFor(() => expect(sent).toEqual([{ text: "hello", mentions: [] }]));
});

test("reaching the start asks for an older page", () => {
  const onLoadOlder = vi.fn();
  renderWithI18n(
    <GlobalChatScreen
      {...props({ onLoadOlder, state: { ...stateWith(message(2, "I'm in")), hasOlder: true } })}
    />,
  );
  fireEvent.click(screen.getByText("start-reached"));
  expect(onLoadOlder).toHaveBeenCalledOnce();
});

test("keeps opening separate from read visibility and preserves list continuity props", () => {
  const onVisible = vi.fn();
  const onMarkThrough = vi.fn();
  const onSnapshot = vi.fn();
  renderWithI18n(
    <GlobalChatScreen
      {...props({
        candidates: [{ userId: "current" as UserId, displayName: "Current" }],
        jumpToLatestToken: 3,
        onMarkThrough,
        onSnapshot,
        onVisible,
        readState: { readThrough: 1, seenAfter: [] },
        state: {
          ...stateWith(message(4, "unread", "historical")),
          firstItemIndex: 99_996,
          hasOlder: true,
          historyTruncated: true,
        },
        viewport: {
          virtuoso: { ranges: [], scrollTop: 12 },
          messageIds: [4],
          anchorId: 4,
          anchorOffset: -8,
        },
      })}
    />,
  );

  expect(onVisible).not.toHaveBeenCalled();
  const list = screen.getByRole("region");
  expect(list).toHaveAttribute("data-first-index", "99996");
  expect(list).toHaveAttribute("data-truncated", "true");
  expect(list).toHaveAttribute("data-jump-token", "3");
  expect(list).toHaveAttribute("data-read-through", "1");
  expect(list).toHaveAttribute("data-first-unread", "4");
  expect(list).toHaveAttribute("data-cohort", "current");
  expect(list).toHaveAttribute(
    "data-snapshot",
    JSON.stringify({
      virtuoso: { ranges: [], scrollTop: 12 },
      messageIds: [4],
      anchorId: 4,
      anchorOffset: -8,
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "visible" }));
  fireEvent.click(screen.getByRole("button", { name: "mark-through" }));
  fireEvent.click(screen.getByRole("button", { name: "snapshot" }));
  expect(onVisible).toHaveBeenCalledWith([4]);
  expect(onMarkThrough).toHaveBeenCalledWith(4);
  expect(onSnapshot).toHaveBeenCalledWith({
    virtuoso: { ranges: [], scrollTop: 0 },
    messageIds: [4],
    anchorId: 4,
    anchorOffset: 0,
  });
});

test("keeps exact draft ranges and viewport on an invalid-mention failure", () => {
  const onInvalidMention = vi.fn();
  const draft = {
    text: "hello @Current ",
    mentions: [{ userId: "current" as UserId, start: 6, length: 8 }],
  };
  renderWithI18n(
    <GlobalChatScreen
      {...props({
        draft,
        onInvalidMention,
        viewport: {
          virtuoso: { ranges: [], scrollTop: 12 },
          messageIds: [4],
          anchorId: 4,
          anchorOffset: -8,
        },
      })}
    />,
  );

  expect(screen.getByLabelText("Message")).toHaveValue(draft.text);
  expect(screen.getByRole("region")).toHaveAttribute(
    "data-snapshot",
    JSON.stringify({
      virtuoso: { ranges: [], scrollTop: 12 },
      messageIds: [4],
      anchorId: 4,
      anchorOffset: -8,
    }),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "invalid-mention" }));
  expect(onInvalidMention).toHaveBeenCalledOnce();
});

test("a failed send keeps the controlled draft and renders no error region", async () => {
  renderWithI18n(
    <GlobalChatScreen
      {...props({
        draft: { text: "hello", mentions: [] },
        onSend: vi.fn().mockRejectedValue(new Error("failed")),
      })}
    />,
  );
  fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
  await vi.waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("hello"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
