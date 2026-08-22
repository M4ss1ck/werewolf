import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UserId } from "@werewolf/protocol";
import { createContext, forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { I18nextProvider } from "react-i18next";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { i18n } from "../i18n/i18n.ts";
import { ChatList, type ChatViewportSnapshot } from "./chat-list.tsx";
import type { ClientChatMessage, ConversationKey } from "./model.ts";

type MockProps = {
  data: ClientChatMessage[];
  firstItemIndex?: number;
  initialTopMostItemIndex?: number;
  restoreStateFrom?: { ranges: never[]; scrollTop: number };
  itemContent(index: number, row: ClientChatMessage): React.ReactNode;
  scrollerRef?(element: HTMLElement | null): void;
  atBottomStateChange?(atBottom: boolean): void;
  followOutput?(atBottom: boolean): string | false;
  startReached?(): void;
};

const control = vi.hoisted(() => ({
  props: undefined as MockProps | undefined,
  scrolls: [] as unknown[],
  state: { ranges: [], scrollTop: 37 } as { ranges: never[]; scrollTop: number },
  setAtBottom: undefined as ((value: boolean) => void) | undefined,
}));

const trustedListeners = new WeakMap<EventTarget, Map<string, EventListener>>();

vi.mock("react-virtuoso", () => {
  const VirtuosoMockContext = createContext({ viewportHeight: 300, itemHeight: 40 });
  const Virtuoso = forwardRef<unknown, MockProps>((props, ref) => {
    const scroller = useRef<HTMLDivElement>(null);
    const mounted = useRef(false);
    useImperativeHandle(ref, () => ({
      getState(callback: (state: typeof control.state) => void) {
        callback(control.state);
      },
      scrollToIndex(location: unknown) {
        control.scrolls.push(location);
      },
    }));
    useEffect(() => {
      control.props = props;
      control.setAtBottom = props.atBottomStateChange;
      props.scrollerRef?.(scroller.current);
      if (!mounted.current) {
        mounted.current = true;
        props.atBottomStateChange?.(true);
      }
    }, [props]);
    return (
      <div data-testid="virtuoso">
        <div data-testid="virtuoso-scroller" ref={scroller}>
          {props.data.map((row, index) => (
            <div key={row.id}>{props.itemContent(index, row)}</div>
          ))}
        </div>
        <button data-testid="start-reached" onClick={() => props.startReached?.()} type="button" />
      </div>
    );
  });
  return { Virtuoso, VirtuosoMockContext };
});

type ObserverEntry = {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
  boundingClientRect: DOMRect;
};

class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  readonly root: Element | null;
  readonly observed = new Set<Element>();
  private readonly callback: (entries: ObserverEntry[]) => void;

  constructor(callback: (entries: ObserverEntry[]) => void, options?: { root?: Element | null }) {
    this.callback = callback;
    this.root = options?.root ?? null;
    ControlledIntersectionObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observed.add(element);
  }

  unobserve(element: Element) {
    this.observed.delete(element);
  }

  disconnect() {
    this.observed.clear();
  }

  trigger(target: Element, top: number, ratio = 1, isIntersecting = true) {
    if (!this.observed.has(target)) return;
    this.callback([
      {
        target,
        isIntersecting,
        intersectionRatio: ratio,
        boundingClientRect: { top, bottom: top + 40 } as DOMRect,
      },
    ]);
  }
}

const viewerId = "viewer" as UserId;
const authorId = "author" as UserId;

function message(
  id: number,
  text = `message ${id}`,
  mentions: ClientChatMessage["mentions"] = [],
): ClientChatMessage {
  return { id, authorId, displayName: "Ana", text, mentions, createdAt: id };
}

function renderList(overrides: Partial<React.ComponentProps<typeof ChatList>> = {}) {
  const props: React.ComponentProps<typeof ChatList> = {
    conversationKey: "global",
    messages: [message(1), message(2), message(3)],
    identityCohort: [],
    viewerId,
    readState: { readThrough: 0, seenAfter: [] },
    jumpToLatestToken: 0,
    emptyLabel: "No messages",
    onSnapshot: vi.fn(),
    onVisible: vi.fn(),
    onMarkThrough: vi.fn(),
    ...overrides,
  };
  return render(
    <I18nextProvider i18n={i18n}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
        <ChatList {...props} />
      </VirtuosoMockContext.Provider>
    </I18nextProvider>,
  );
}

function flushArm() {
  act(() => vi.advanceTimersByTime(32));
}

function dispatchTrusted(target: EventTarget, type: string) {
  trustedListeners.get(target)?.get(type)?.({ isTrusted: true, target } as Event);
}

beforeEach(() => {
  vi.useFakeTimers();
  control.props = undefined;
  control.scrolls = [];
  control.setAtBottom = undefined;
  ControlledIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (listener && typeof listener === "function" && this instanceof HTMLElement) {
      if (this.dataset.testid === "virtuoso-scroller") {
        const listeners = trustedListeners.get(this) ?? new Map<string, EventListener>();
        listeners.set(type, listener);
        trustedListeners.set(this, listeners);
      }
    }
    return originalAddEventListener.call(this, type, listener, options);
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  localStorage.clear();
  document.documentElement.dataset.reducedMotion = "false";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChatList viewport and unread mechanics", () => {
  test("empty visits reconnect the observer, focus evidence, and initial positioning", () => {
    const onVisible = vi.fn();
    const view = renderList({ messages: [], onVisible });
    expect(ControlledIntersectionObserver.instances).toHaveLength(0);
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={onVisible}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    flushArm();
    expect(control.scrolls.at(-1)).toMatchObject({ index: 1, behavior: "auto" });
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    const root = screen.getByTestId("virtuoso-scroller");
    const row = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    expect(observer.root).toBe(root);
    expect(observer.observed.has(row)).toBe(true);
    act(() => dispatchTrusted(root, "pointerdown"));
    act(() => observer.trigger(row, 100));
    expect(onVisible).toHaveBeenCalledWith([1]);
  });

  test("recreated scrollers do not reuse old row geometry", () => {
    const onSnapshot = vi.fn();
    const view = renderList({ messages: [message(1), message(2)], onSnapshot });
    flushArm();
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    const firstRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    act(() => observer.trigger(firstRow, 80));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({ anchorOffset: 0 });
    view.unmount();
  });

  test("same-key reconnect reapplies opening priority after an empty visit", () => {
    const view = renderList({
      messages: [message(1), message(2)],
      readState: { readThrough: 0, seenAfter: [] },
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 0, behavior: "auto" });
    control.scrolls = [];
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(3), message(4)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 0, behavior: "auto" });
    view.unmount();
  });

  test("observer teardown clears geometry even when the root is reused", () => {
    const onSnapshot = vi.fn();
    const firstVisible = vi.fn();
    const secondVisible = vi.fn();
    const view = renderList({
      messages: [message(1), message(2)],
      onSnapshot,
      onVisible: firstVisible,
    });
    flushArm();
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    const firstRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    act(() => observer.trigger(firstRow, 80));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={secondVisible}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({ anchorOffset: 0 });
    view.unmount();
  });

  test("opening prioritizes oldest unread, then exact snapshots, then bottom", () => {
    const { unmount } = renderList({ readState: { readThrough: 1, seenAfter: [] } });
    expect(control.props?.initialTopMostItemIndex).toBe(1);
    unmount();

    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 12 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: -8,
    };
    const restored = renderList({ readState: { readThrough: 3, seenAfter: [] }, snapshot });
    expect(control.props?.restoreStateFrom).toEqual(snapshot.virtuoso);
    restored.unmount();
    renderList({ readState: { readThrough: 3, seenAfter: [] } });
    expect(control.props?.initialTopMostItemIndex).toBe(2);
  });

  test("initial anchor and expired restoration always use auto motion", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 8 },
      messageIds: [1, 2],
      anchorId: 1,
      anchorOffset: 12,
    };
    const anchored = renderList({
      messages: [message(1), message(3)],
      readState: { readThrough: 3, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ behavior: "auto" });
    anchored.unmount();
    cleanup();
    control.scrolls = [];

    const expired = renderList({
      messages: [message(3), message(4)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ behavior: "auto" });
    expect(control.props?.followOutput?.(true)).toBe("smooth");
    expired.unmount();
  });

  test("an empty visit freezes the first unread when history arrives", () => {
    const view = renderList({ messages: [], readState: { readThrough: 0, seenAfter: [] } });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(control.props?.initialTopMostItemIndex).toBe(0);
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Unread");
    flushArm();
    const observer = ControlledIntersectionObserver.instances[0]!;
    const firstRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    act(() => observer.trigger(firstRow, 100));

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Unread");
    view.unmount();
  });

  test("conversation changes recompute the unread target and frozen divider", () => {
    const view = renderList({
      conversationKey: "global",
      messages: [message(1), message(2)],
      readState: { readThrough: 0, seenAfter: [] },
    });
    expect(control.props?.initialTopMostItemIndex).toBe(0);
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Unread");

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(10), message(11)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 10, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(control.props?.initialTopMostItemIndex).toBe(1);
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Unread");
    expect(document.querySelector("[data-message-id='1']")).not.toBeInTheDocument();
    view.unmount();
  });

  test("expired anchors fall back to the oldest retained row and preserve first index", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 88 },
      messageIds: [1, 2],
      anchorId: 1,
      anchorOffset: 14,
    };
    renderList({
      firstItemIndex: 20,
      messages: [message(3), message(4)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    expect(control.props?.initialTopMostItemIndex).toBe(20);
    expect(control.props?.firstItemIndex).toBe(20);
  });

  test("restores a retained anchor offset across append, prepend, and trim", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 44 },
      messageIds: [2, 3],
      anchorId: 3,
      anchorOffset: 12,
    };
    const appended = renderList({
      messages: [message(2), message(3), message(4)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 1, offset: 12 });
    appended.unmount();
    cleanup();

    control.scrolls = [];
    const prepended = renderList({
      firstItemIndex: 9,
      messages: [message(1), message(2), message(3)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 11, offset: 12 });
    prepended.unmount();
    cleanup();

    control.scrolls = [];
    const trimmed = renderList({
      messages: [message(3), message(4)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot: { ...snapshot, messageIds: [2, 3, 4] },
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 0, offset: 12 });
    trimmed.unmount();
  });

  test("trimmed rows leave no expired geometry for a later snapshot", () => {
    const onSnapshot = vi.fn();
    const view = renderList({ messages: [message(1), message(2)], onSnapshot });
    flushArm();
    const observer = ControlledIntersectionObserver.instances[0]!;
    const firstRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    act(() => observer.trigger(firstRow, 80));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(2), message(3)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 3, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    const snapshot = onSnapshot.mock.lastCall?.[0] as ChatViewportSnapshot;
    expect(snapshot.anchorId).not.toBe(1);
    expect(snapshot.messageIds).toEqual([1, 2]);
    view.unmount();
  });

  test("getState snapshot stores exact IDs and partially visible top anchor offset", () => {
    const onSnapshot = vi.fn();
    const view = renderList({ onSnapshot });
    flushArm();
    const root = screen.getByTestId("virtuoso-scroller");
    root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const observer = ControlledIntersectionObserver.instances[0]!;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    act(() => {
      observer.trigger(rows[0]!, 90);
      observer.trigger(rows[1]!, 112);
    });
    act(() => dispatchTrusted(root, "pointerdown"));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(1), message(2), message(3)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={onSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    const snapshot = onSnapshot.mock.lastCall?.[0] as ChatViewportSnapshot;
    expect(snapshot.messageIds).toEqual([1, 2, 3]);
    expect(snapshot.anchorId).toBe(1);
    expect(snapshot.anchorOffset).toBe(-10);
  });

  test("conversation cleanup snapshots use the old IDs and callback", () => {
    const oldSnapshot = vi.fn();
    const newSnapshot = vi.fn();
    const view = renderList({ messages: [message(1)], onSnapshot: oldSnapshot });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(10)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 10, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={newSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(oldSnapshot).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [1] }));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g2:public" as ConversationKey}
            messages={[message(20)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 20, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={newSnapshot}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(newSnapshot).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [10] }));
    view.unmount();
  });

  test("freezes the unread divider and marks viewer mentions", () => {
    const { rerender } = renderList({
      messages: [message(1, "@you", [{ userId: viewerId, start: 0, length: 4 }]), message(2)],
      readState: { readThrough: 0, seenAfter: [] },
    });
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Mentioned you");
    rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1, "@you", [{ userId: viewerId, start: 0, length: 4 }]), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Mentioned you");
  });

  test("malformed viewer ranges never create divider or navigation mention cues", () => {
    const malformed = [
      { userId: viewerId, start: 0, length: 4 },
      { userId: "other" as UserId, start: 1, length: 2 },
    ];
    renderList({
      messages: [message(1, "@you", malformed), message(2)],
      readState: { readThrough: 0, seenAfter: [] },
    });
    expect(document.querySelector(".divider-note__text")).toHaveTextContent("Unread");
    expect(screen.getByRole("button", { name: /Jump to first unread/ })).not.toHaveAccessibleName(
      /Mentioned you/,
    );
    act(() => control.setAtBottom?.(false));
    expect(screen.getByRole("button", { name: /Jump to latest/ })).not.toHaveAccessibleName(
      /Mentioned you/,
    );
  });

  test("only positive actual intersections after the two-frame arm report visibility", () => {
    const onVisible = vi.fn();
    renderList({ onVisible });
    const observer = ControlledIntersectionObserver.instances[0]!;
    const row = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    act(() => observer.trigger(row, 100, 1, true));
    expect(onVisible).not.toHaveBeenCalled();
    flushArm();
    expect(onVisible).not.toHaveBeenCalled();
    act(() => observer.trigger(row, 100, 0, true));
    expect(onVisible).not.toHaveBeenCalled();
    act(() => {
      dispatchTrusted(screen.getByTestId("virtuoso-scroller"), "pointerdown");
      dispatchTrusted(screen.getByTestId("virtuoso-scroller"), "keydown");
    });
    act(() => observer.trigger(row, 100, 1, true));
    expect(onVisible).toHaveBeenCalledWith([1]);
    expect(observer.root).toBe(screen.getByTestId("virtuoso-scroller"));
  });

  test("untrusted programmatic input and hidden/blurred windows do not report", () => {
    const onVisible = vi.fn();
    renderList({ onVisible });
    flushArm();
    const root = screen.getByTestId("virtuoso-scroller");
    const row = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    act(() => window.dispatchEvent(new Event("blur")));
    fireEvent.pointerDown(root);
    act(() => ControlledIntersectionObserver.instances[0]!.trigger(row, 100));
    expect(onVisible).not.toHaveBeenCalled();
    act(() => dispatchTrusted(root, "wheel"));
    act(() => ControlledIntersectionObserver.instances[0]!.trigger(row, 100));
    expect(onVisible).toHaveBeenCalledWith([1]);
    onVisible.mockClear();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => dispatchTrusted(root, "touchstart"));
    act(() => ControlledIntersectionObserver.instances[0]!.trigger(row, 100));
    expect(onVisible).not.toHaveBeenCalled();
  });

  test("at-bottom follows, off-bottom does not, and navigation marks through only down", () => {
    const onMarkThrough = vi.fn();
    renderList({
      messages: [
        message(1),
        message(2),
        message(3, "@you", [{ userId: viewerId, start: 0, length: 4 }]),
      ],
      onMarkThrough,
      readState: { readThrough: 0, seenAfter: [] },
    });
    expect(control.props?.followOutput?.(true)).toBe("smooth");
    act(() => control.setAtBottom?.(false));
    expect(control.props?.followOutput?.(false)).toBe(false);
    const down = screen.getByRole("button", { name: /Jump to latest/ });
    expect(down).toHaveAccessibleName(/3 unread messages/);
    expect(down).toHaveAccessibleName(/Mentioned you/);
    fireEvent.click(down);
    expect(onMarkThrough).toHaveBeenCalledWith(3);
    expect(control.scrolls.at(-1)).toMatchObject({ index: 2, align: "end" });

    act(() => control.setAtBottom?.(true));
    expect(screen.getByRole("button", { name: /Jump to first unread/ })).toBeInTheDocument();
    expect(onMarkThrough).toHaveBeenCalledTimes(1);
  });

  test("down navigation counts only unread rows below the actual visible rows", () => {
    const onVisible = vi.fn();
    renderList({
      messages: [
        message(1),
        message(2),
        message(3),
        message(4, "@you", [{ userId: viewerId, start: 0, length: 99 }]),
      ],
      onVisible,
      readState: { readThrough: 0, seenAfter: [] },
    });
    const root = screen.getByTestId("virtuoso-scroller");
    const observer = ControlledIntersectionObserver.instances[0]!;
    flushArm();
    act(() => dispatchTrusted(root, "wheel"));
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    act(() => {
      observer.trigger(rows[0]!, 100);
      observer.trigger(rows[1]!, 140);
      control.setAtBottom?.(false);
    });
    const down = screen.getByRole("button", { name: /Jump to latest/ });
    expect(down).toHaveAccessibleName("Jump to latest, 2 unread messages");
    expect(down).not.toHaveAccessibleName(/Mentioned you/);
    expect(onVisible).toHaveBeenCalledWith([1, 2]);
  });

  test("down mention cue follows only validated mentions below the visible rows", () => {
    const visibleMention = [{ userId: viewerId, start: 0, length: 4 }];
    const view = renderList({
      messages: [message(1, "@you", visibleMention), message(2), message(3)],
      readState: { readThrough: 0, seenAfter: [] },
    });
    const root = screen.getByTestId("virtuoso-scroller");
    const observer = ControlledIntersectionObserver.instances[0]!;
    flushArm();
    act(() => dispatchTrusted(root, "wheel"));
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    act(() => {
      observer.trigger(rows[0]!, 100);
      observer.trigger(rows[1]!, 140);
      control.setAtBottom?.(false);
    });
    const down = screen.getByRole("button", { name: /Jump to latest/ });
    expect(down).toHaveAccessibleName("Jump to latest, 1 unread message");
    expect(down).not.toHaveAccessibleName(/Mentioned you/);

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[
              message(1, "@you", visibleMention),
              message(2),
              message(3, "@you", visibleMention),
            ]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toHaveAccessibleName(
      /Mentioned you/,
    );
  });

  test("down navigation displays 99+ and zero is icon-only", () => {
    const many = Array.from({ length: 100 }, (_, index) => message(index + 1));
    const manyView = renderList({ messages: many, readState: { readThrough: 0, seenAfter: [] } });
    act(() => control.setAtBottom?.(false));
    expect(screen.getByText("99+")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /100 unread messages/ })).toHaveAccessibleName(
      /100 unread messages/,
    );
    manyView.unmount();
    const { unmount } = renderList({ readState: { readThrough: 3, seenAfter: [] } });
    act(() => control.setAtBottom?.(false));
    const button = screen.getAllByRole("button", { name: /Jump to latest/ }).at(-1)!;
    expect(button.querySelector(".chat-list__count")).toBeNull();
    unmount();
  });

  test("up navigation targets oldest unread without marking through", () => {
    const onMarkThrough = vi.fn();
    renderList({ onMarkThrough, readState: { readThrough: 1, seenAfter: [] } });
    const up = screen.getByRole("button", { name: /Jump to first unread/ });
    fireEvent.click(up);
    expect(control.scrolls.at(-1)).toMatchObject({ index: 1, align: "start" });
    expect(onMarkThrough).not.toHaveBeenCalled();
  });

  test("success jump waits for a newly present row and then marks latest", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ onMarkThrough, jumpToLatestToken: 0 });
    act(() => control.setAtBottom?.(false));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={1}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    expect(onMarkThrough).not.toHaveBeenCalled();
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2), message(3)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={1}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());
    expect(onMarkThrough).toHaveBeenCalledWith(3);
  });

  test("pending latest jumps do not cross conversation boundaries", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({
      conversationKey: "global",
      messages: [message(1)],
      readState: { readThrough: 1, seenAfter: [] },
      jumpToLatestToken: 0,
      onMarkThrough,
    });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 1, seenAfter: [] }}
            jumpToLatestToken={1}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(10)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 10, seenAfter: [] }}
            jumpToLatestToken={1}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());
    expect(onMarkThrough).not.toHaveBeenCalled();
  });

  test("held identity cohort keeps duplicate-name rows and mentions distinct", () => {
    const firstUser = "dup0" as UserId;
    const secondUser = "dup8" as UserId;
    const rows = [
      {
        ...message(1, "@Alex", [{ userId: secondUser, start: 0, length: 5 }]),
        authorId: firstUser,
        displayName: "Alex",
      },
      { ...message(2, "hello"), authorId: secondUser, displayName: "Álex" },
    ];
    renderList({
      messages: rows,
      identityCohort: [
        { userId: firstUser, displayName: "Alex" },
        { userId: secondUser, displayName: "Álex" },
      ],
      readState: { readThrough: 2, seenAfter: [] },
    });
    const firstSigil = document.querySelector<SVGElement>("[data-message-id='1'] svg circle")!;
    const secondSigil = document.querySelector<SVGElement>("[data-message-id='2'] svg circle")!;
    expect(firstSigil.getAttribute("stroke")).not.toBe(secondSigil.getAttribute("stroke"));
    const mention = document.querySelector<HTMLElement>("[data-message-id='1'] .chat-mention")!;
    const secondAuthor = document.querySelector<HTMLElement>(
      "[data-message-id='2'] .chat-identity-mark",
    )!;
    expect(mention.style.getPropertyValue("--identity-color")).toBe(
      secondAuthor.style.getPropertyValue("--identity-color"),
    );
  });

  test("reduced motion sources change behavior but not target", () => {
    renderList();
    expect(control.props?.followOutput?.(true)).toBe("smooth");
    localStorage.setItem("werewolf.prefs.reducedMotion", "true");
    expect(control.props?.followOutput?.(true)).toBe("auto");
    localStorage.clear();
    document.documentElement.dataset.reducedMotion = "true";
    expect(control.props?.followOutput?.(true)).toBe("auto");
    document.documentElement.dataset.reducedMotion = "false";
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    expect(control.props?.followOutput?.(true)).toBe("auto");
  });

  test("start reached pages only when hasOlder and truncated copy is conditional", () => {
    const onLoadOlder = vi.fn();
    const noOlder = renderList({ onLoadOlder, hasOlder: false });
    fireEvent.click(screen.getByTestId("start-reached"));
    expect(onLoadOlder).not.toHaveBeenCalled();
    noOlder.unmount();
    const { unmount } = renderList({ onLoadOlder, hasOlder: true, historyTruncated: true });
    fireEvent.click(screen.getByTestId("start-reached"));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Earlier messages are no longer available")).toHaveLength(1);
    unmount();
    renderList({ historyTruncated: false });
    expect(screen.queryByText("Earlier messages are no longer available")).not.toBeInTheDocument();
  });

  test("empty lists are safe", () => {
    renderList({ messages: [], historyTruncated: true });
    expect(screen.getByText("No messages")).toBeInTheDocument();
    expect(screen.getByText("Earlier messages are no longer available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Jump/ })).not.toBeInTheDocument();
  });
});
