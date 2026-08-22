import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UserId } from "@werewolf/protocol";
import {
  createContext,
  forwardRef,
  StrictMode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { type StateSnapshot, VirtuosoMockContext } from "react-virtuoso";
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
  state: { ranges: [], scrollTop: 37 } as StateSnapshot,
  getStateMode: "sync" as "sync" | "defer" | "none",
  handleAvailable: true,
  deferredStates: [] as Array<(state: StateSnapshot) => void>,
  setAtBottom: undefined as ((value: boolean) => void) | undefined,
}));

const trustedListeners = new WeakMap<EventTarget, Map<string, EventListener>>();

vi.mock("react-virtuoso", () => {
  const VirtuosoMockContext = createContext({ viewportHeight: 300, itemHeight: 40 });
  const Virtuoso = forwardRef<unknown, MockProps>((props, ref) => {
    const scroller = useRef<HTMLDivElement>(null);
    const mounted = useRef(false);
    useImperativeHandle(ref, () =>
      control.handleAvailable
        ? {
            getState(callback: (state: typeof control.state) => void) {
              if (control.getStateMode === "none") return;
              if (control.getStateMode === "defer") {
                control.deferredStates.push(callback);
                return;
              }
              callback(control.state);
            },
            scrollToIndex(location: unknown) {
              control.scrolls.push(location);
            },
          }
        : null,
    );
    useEffect(() => {
      control.props = props;
      control.setAtBottom = props.atBottomStateChange;
      props.scrollerRef?.(scroller.current);
      if (!mounted.current) {
        mounted.current = true;
        props.atBottomStateChange?.(true);
      }
    }, [props]);
    const restoreScrollTop = props.restoreStateFrom?.scrollTop;
    useEffect(() => {
      if (restoreScrollTop === undefined) return;
      const frames: number[] = [];
      const restoreAfterFrame = (remaining: number) => {
        frames.push(
          requestAnimationFrame(() => {
            if (remaining === 1) {
              if (scroller.current) scroller.current.scrollTop = 0;
              return;
            }
            restoreAfterFrame(remaining - 1);
          }),
        );
      };
      restoreAfterFrame(4);
      return () => {
        for (const frame of frames) cancelAnimationFrame(frame);
      };
    }, [restoreScrollTop]);
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
    this.triggerStale(target, top, ratio, isIntersecting);
  }

  triggerStale(target: Element, top: number, ratio = 1, isIntersecting = true) {
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
  control.state = { ranges: [], scrollTop: 37 };
  control.getStateMode = "sync";
  control.handleAvailable = true;
  control.deferredStates = [];
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
    flushArm();
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

  test("consumes a pending latest jump when the first row arrives", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ messages: [], onMarkThrough });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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

    const jumps = control.scrolls.filter(
      (location) =>
        (location as { align?: string; behavior?: string }).align === "end" &&
        (location as { behavior?: string }).behavior === "smooth",
    );
    expect(jumps).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledOnce();

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
    expect(
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      ),
    ).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledOnce();
    view.unmount();
  });

  test("jumps when a new token and the first row arrive together", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ messages: [], onMarkThrough });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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

    expect(
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      ),
    ).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledOnce();
    view.unmount();
  });

  test("clears an older pending token when a newer token jumps with the first row", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ messages: [], onMarkThrough });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={2}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={2}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());

    expect(
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      ),
    ).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledOnce();
    view.unmount();
  });

  test("keeps a scheduled jump alive when another row arrives before the frame", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ messages: [], onMarkThrough });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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

    const jumps = () =>
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      );
    expect(jumps()).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledWith(2);
    expect(onMarkThrough).toHaveBeenCalledOnce();

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(10)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
    expect(jumps()).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledOnce();
    view.unmount();
  });

  test("waits for the newest token after a scheduled token is superseded", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ messages: [], onMarkThrough });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
            conversationKey="global"
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={2}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());
    expect(
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      ),
    ).toHaveLength(0);
    expect(onMarkThrough).not.toHaveBeenCalled();

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={2}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={onMarkThrough}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());
    expect(
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      ),
    ).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledWith(2);
    expect(onMarkThrough).toHaveBeenCalledOnce();
    view.unmount();
  });

  test("keeps ordinary nonempty append jumps intact", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ messages: [message(1)], onMarkThrough });
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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

    expect(
      control.scrolls.filter(
        (location) =>
          (location as { align?: string; behavior?: string }).align === "end" &&
          (location as { behavior?: string }).behavior === "smooth",
      ),
    ).toHaveLength(1);
    expect(onMarkThrough).toHaveBeenCalledOnce();
    view.unmount();
  });

  test("conversation cleanup snapshots preserve current geometry when the root is reused", () => {
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
    const root = screen.getByTestId("virtuoso-scroller");
    root.getBoundingClientRect = () => ({ top: 0, bottom: 300 }) as DOMRect;
    const firstRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    const secondRow = document.querySelector<HTMLElement>("[data-message-id='2']")!;
    firstRow.getBoundingClientRect = () => ({ top: 80, bottom: 120 }) as DOMRect;
    secondRow.getBoundingClientRect = () => ({ top: 160, bottom: 200 }) as DOMRect;
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
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({ anchorOffset: 80 });
    view.unmount();
  });

  test("stale observer callbacks cannot restore a replaced row", () => {
    const onVisible = vi.fn();
    const view = renderList({ messages: [message(1)], onVisible });
    flushArm();
    const oldObserver = ControlledIntersectionObserver.instances[0]!;
    const oldRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            onSnapshot={vi.fn()}
            onVisible={onVisible}
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
            messages={[message(1)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 0, seenAfter: [] }}
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
    const currentObserver = ControlledIntersectionObserver.instances.at(-1)!;
    const currentRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    expect(currentRow).not.toBe(oldRow);

    act(() => {
      oldObserver.triggerStale(oldRow, 100);
      currentObserver.triggerStale(oldRow, 100);
    });
    expect(onVisible).not.toHaveBeenCalled();

    act(() => currentObserver.trigger(currentRow, 100));
    expect(onVisible).toHaveBeenCalledWith([1]);
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
    expect(control.props?.initialTopMostItemIndex).toBe(0);
    expect(control.props?.firstItemIndex).toBe(20);
  });

  test("retries an absent snapshot anchor after older history prepends", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4600 },
      messageIds: [2, 3, 4],
      anchorId: 2,
      anchorOffset: 12,
    };
    const view = renderList({
      hasOlder: true,
      messages: [message(3), message(4)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 0 });

    control.scrolls = [];
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            hasOlder
            messages={[message(1), message(2), message(3), message(4)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 4, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            snapshot={snapshot}
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());

    expect(control.scrolls.at(-1)).toMatchObject({
      index: 1,
      align: "start",
      offset: 12,
      behavior: "auto",
    });
    view.unmount();
  });

  test("finalizes an absent snapshot fallback when no older history remains", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4600 },
      messageIds: [2, 3, 4],
      anchorId: 2,
      anchorOffset: 12,
    };
    const view = renderList({
      messages: [message(3), message(4)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    expect(control.scrolls.at(-1)).toMatchObject({ index: 0 });
    control.scrolls = [];

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(3), message(4)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 4, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            snapshot={{ ...snapshot }}
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());

    expect(control.scrolls).toHaveLength(0);
    view.unmount();
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
    expect(control.scrolls.at(-1)).toMatchObject({ index: 2, offset: 12 });
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

  test("repositions a retained anchor when exact initial IDs later diverge", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4600 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: 12,
    };
    const view = renderList({
      firstItemIndex: 9,
      messages: [message(1), message(2), message(3)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot,
    });
    act(() => vi.runAllTimers());
    control.scrolls = [];

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            firstItemIndex={9}
            messages={[message(1), message(2), message(3), message(4)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 4, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            snapshot={snapshot}
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());

    expect(control.scrolls.at(-1)).toMatchObject({
      index: 1,
      offset: 12,
      align: "start",
      behavior: "auto",
    });
    view.unmount();
  });

  test("does not restart divergent anchor correction on identical rerenders", () => {
    const snapshot = (): ChatViewportSnapshot => ({
      virtuoso: { ranges: [], scrollTop: 4600 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: 12,
    });
    const renderDiverged = (view: ReturnType<typeof render>) =>
      view.rerender(
        <I18nextProvider i18n={i18n}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
            <ChatList
              conversationKey="global"
              firstItemIndex={9}
              messages={[message(1), message(2), message(3), message(4)]}
              identityCohort={[]}
              viewerId={viewerId}
              readState={{ readThrough: 4, seenAfter: [] }}
              jumpToLatestToken={0}
              emptyLabel="No messages"
              snapshot={snapshot()}
              onSnapshot={vi.fn()}
              onVisible={vi.fn()}
              onMarkThrough={vi.fn()}
            />
          </VirtuosoMockContext.Provider>
        </I18nextProvider>,
      );
    const view = renderList({
      firstItemIndex: 9,
      messages: [message(1), message(2), message(3)],
      readState: { readThrough: 4, seenAfter: [] },
      snapshot: snapshot(),
    });
    act(() => vi.runAllTimers());
    control.scrolls = [];

    const pendingFrames = new Map<number, (time: number) => void>();
    let nextFrame = 1;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const id = nextFrame++;
        pendingFrames.set(id, callback);
        return id;
      });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      pendingFrames.delete(id);
    });
    act(() => renderDiverged(view));
    for (let frame = 0; frame < 3; frame += 1) {
      const framesBeforeRerender = [...pendingFrames.entries()];
      act(() => renderDiverged(view));
      for (const [id, callback] of framesBeforeRerender) {
        if (pendingFrames.get(id) !== callback) continue;
        pendingFrames.delete(id);
        act(() => callback(0));
      }
    }

    expect(control.scrolls).toHaveLength(1);
    expect(control.scrolls[0]).toMatchObject({
      index: 1,
      offset: 12,
      align: "start",
      behavior: "auto",
    });
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
    view.unmount();
  });

  test("does not retarget a retained anchor to a new unread row", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4600 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: 12,
    };
    const view = renderList({
      messages: [message(1), message(2), message(3)],
      readState: { readThrough: 3, seenAfter: [] },
      snapshot,
    });

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2), message(3), message(4)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 3, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            snapshot={snapshot}
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    act(() => vi.runAllTimers());

    expect(control.scrolls.at(-1)).toMatchObject({
      index: 1,
      offset: 12,
      align: "start",
      behavior: "auto",
    });
    view.unmount();
  });

  test("delays exact snapshot restoration until after Virtuoso and read arm", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 826 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: 12,
    };
    const onVisible = vi.fn();
    const view = render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
            <ChatList
              conversationKey="global"
              firstItemIndex={100000}
              messages={[message(1), message(2), message(3)]}
              identityCohort={[]}
              viewerId={viewerId}
              readState={{ readThrough: 3, seenAfter: [] }}
              jumpToLatestToken={0}
              emptyLabel="No messages"
              snapshot={snapshot}
              onSnapshot={vi.fn()}
              onVisible={onVisible}
              onMarkThrough={vi.fn()}
            />
          </VirtuosoMockContext.Provider>
        </I18nextProvider>
      </StrictMode>,
    );

    expect(control.props?.restoreStateFrom).toEqual(snapshot.virtuoso);
    const scroller = screen.getByTestId("virtuoso-scroller");
    const firstRow = document.querySelector<HTMLElement>('[data-message-id="1"]')!;
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    act(() => observer.trigger(firstRow, 0));
    expect(onVisible).not.toHaveBeenCalled();

    for (let frame = 0; frame < 6; frame += 1) {
      act(() => vi.advanceTimersByTime(16));
      act(() => observer.trigger(firstRow, 0));
      expect(onVisible).not.toHaveBeenCalled();
    }
    expect(scroller.scrollTop).toBe(826);
    expect(control.scrolls).toHaveLength(0);
    act(() => vi.advanceTimersByTime(16));
    act(() => observer.trigger(firstRow, 0));
    expect(onVisible).toHaveBeenCalledWith([1]);
    view.unmount();
  });

  test("completes exact restoration through identical-content rerenders", () => {
    const onVisible = vi.fn();
    const renderExact = (snapshot: ChatViewportSnapshot) => (
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            firstItemIndex={100000}
            messages={[message(1), message(2), message(3)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 3, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            snapshot={snapshot}
            onSnapshot={vi.fn()}
            onVisible={onVisible}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>
    );
    const snapshot = (): ChatViewportSnapshot => ({
      virtuoso: { ranges: [], scrollTop: 826 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: 12,
    });
    const view = render(renderExact(snapshot()));
    const scroller = screen.getByTestId("virtuoso-scroller");
    const firstRow = document.querySelector<HTMLElement>('[data-message-id="1"]')!;
    const observer = ControlledIntersectionObserver.instances.at(-1)!;

    for (let frame = 0; frame < 6; frame += 1) {
      act(() => {
        view.rerender(renderExact(snapshot()));
        vi.advanceTimersByTime(16);
      });
      act(() => observer.trigger(firstRow, 0));
      expect(onVisible).not.toHaveBeenCalled();
    }
    expect(scroller.scrollTop).toBe(826);

    act(() => {
      view.rerender(renderExact(snapshot()));
      vi.advanceTimersByTime(16);
    });
    act(() => observer.trigger(firstRow, 0));
    expect(onVisible).toHaveBeenCalledWith([1]);
    view.unmount();
  });

  test("keeps exact snapshot restoration when read state later adds an unread row", () => {
    const snapshot: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4600 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: 12,
    };
    const view = renderList({
      messages: [message(1), message(2), message(3)],
      readState: { readThrough: 3, seenAfter: [] },
      snapshot,
    });
    expect(control.props?.restoreStateFrom).toEqual(snapshot.virtuoso);

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            messages={[message(1), message(2), message(3)]}
            identityCohort={[]}
            viewerId={viewerId}
            readState={{ readThrough: 2, seenAfter: [] }}
            jumpToLatestToken={0}
            emptyLabel="No messages"
            snapshot={snapshot}
            onSnapshot={vi.fn()}
            onVisible={vi.fn()}
            onMarkThrough={vi.fn()}
          />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );

    expect(control.props?.restoreStateFrom).toEqual(snapshot.virtuoso);
    act(() => vi.runAllTimers());
    expect(screen.getByTestId("virtuoso-scroller").scrollTop).toBe(4600);
    expect(control.scrolls).toHaveLength(0);
    view.unmount();
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
    root.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    const observer = ControlledIntersectionObserver.instances[0]!;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    rows[0]!.getBoundingClientRect = () => ({ top: 90, bottom: 130 }) as DOMRect;
    rows[1]!.getBoundingClientRect = () => ({ top: 112, bottom: 152 }) as DOMRect;
    rows[2]!.getBoundingClientRect = () => ({ top: 180, bottom: 220 }) as DOMRect;
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
    expect(snapshot.anchorId).toBe(2);
    expect(snapshot.anchorOffset).toBe(12);
  });

  test("snapshot capture prefers fresh DOM geometry over stale observer rows", () => {
    const onSnapshot = vi.fn();
    const view = renderList({ onSnapshot });
    flushArm();
    const root = screen.getByTestId("virtuoso-scroller");
    root.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    rows[0]!.getBoundingClientRect = () => ({ top: 180, bottom: 220 }) as DOMRect;
    rows[1]!.getBoundingClientRect = () => ({ top: 90, bottom: 130 }) as DOMRect;
    rows[2]!.getBoundingClientRect = () => ({ top: 150, bottom: 190 }) as DOMRect;
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    act(() => observer.trigger(rows[0]!, 90));

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(1), message(2), message(3)]}
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
    expect(snapshot.anchorId).toBe(3);
    expect(snapshot.anchorOffset).toBe(50);
    view.unmount();
  });

  test("snapshot capture ignores mounted rows outside the viewport", () => {
    const onSnapshot = vi.fn();
    const view = renderList({ onSnapshot, messages: [message(1), message(2)] });
    flushArm();
    const root = screen.getByTestId("virtuoso-scroller");
    root.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    rows[0]!.getBoundingClientRect = () => ({ top: 50, bottom: 250 }) as DOMRect;
    rows[1]!.getBoundingClientRect = () => ({ top: 300, bottom: 340 }) as DOMRect;
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    act(() => observer.trigger(rows[0]!, 50));

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey={"game:g1:public" as ConversationKey}
            messages={[message(1), message(2)]}
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
    expect(snapshot.anchorId).toBe(1);
    expect(snapshot.anchorOffset).toBe(-50);
    view.unmount();
  });

  test("deferred state falls back and ignores a late callback after cleanup", () => {
    control.getStateMode = "defer";
    const onSnapshot = vi.fn();
    const fallback: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 0 },
      messageIds: [1, 2, 3],
      anchorId: 1,
      anchorOffset: 0,
    };
    const view = renderList({ onSnapshot, fallbackSnapshot: fallback });

    flushArm();
    view.unmount();

    expect(onSnapshot).toHaveBeenCalledWith(fallback);
    const calls = onSnapshot.mock.calls.length;
    act(() => {
      for (const callback of control.deferredStates) callback(control.state);
    });
    expect(onSnapshot).toHaveBeenCalledTimes(calls);
  });

  test("unavailable Virtuoso handle uses the fallback snapshot", () => {
    control.handleAvailable = false;
    const onSnapshot = vi.fn();
    const fallback: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 0 },
      messageIds: [1, 2, 3],
      anchorId: 1,
      anchorOffset: 0,
    };
    const view = renderList({ onSnapshot, fallbackSnapshot: fallback });

    flushArm();
    view.unmount();

    expect(onSnapshot).toHaveBeenCalledWith(fallback);
  });

  test("StrictMode cleanup keeps the latest synchronous snapshot", () => {
    const onSnapshot = vi.fn();
    const props: React.ComponentProps<typeof ChatList> = {
      conversationKey: "global",
      messages: [message(1), message(2), message(3)],
      identityCohort: [],
      viewerId,
      readState: { readThrough: 0, seenAfter: [] },
      jumpToLatestToken: 0,
      emptyLabel: "No messages",
      onSnapshot,
      onVisible: vi.fn(),
      onMarkThrough: vi.fn(),
    };
    const view = render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
            <ChatList {...props} />
          </VirtuosoMockContext.Provider>
        </I18nextProvider>
      </StrictMode>,
    );

    flushArm();
    const root = screen.getByTestId("virtuoso-scroller");
    root.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
    rows[0]!.getBoundingClientRect = () => ({ top: 180, bottom: 220 }) as DOMRect;
    rows[1]!.getBoundingClientRect = () => ({ top: 90, bottom: 130 }) as DOMRect;
    rows[2]!.getBoundingClientRect = () => ({ top: 150, bottom: 190 }) as DOMRect;
    view.unmount();

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({
      messageIds: [1, 2, 3],
      anchorId: 3,
      anchorOffset: 50,
      virtuoso: control.state,
    });
  });

  test("StrictMode does not snapshot before the positioning arm", () => {
    const onSnapshot = vi.fn();
    const onVisible = vi.fn();
    const fallback: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 0 },
      messageIds: [1, 2, 3],
      anchorId: 1,
      anchorOffset: 0,
    };
    control.state = fallback.virtuoso;
    const incoming: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4960 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: -12,
    };
    const strictList = (rows: ClientChatMessage[]) => (
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
            <ChatList
              conversationKey="global"
              messages={rows}
              identityCohort={[]}
              viewerId={viewerId}
              readState={{ readThrough: 3, seenAfter: [] }}
              jumpToLatestToken={0}
              emptyLabel="No messages"
              snapshot={incoming}
              fallbackSnapshot={fallback}
              onSnapshot={onSnapshot}
              onVisible={onVisible}
              onMarkThrough={vi.fn()}
            />
          </VirtuosoMockContext.Provider>
        </I18nextProvider>
      </StrictMode>
    );
    const view = render(strictList([message(1), message(2), message(3)]));

    expect(onSnapshot).not.toHaveBeenCalled();

    flushArm();
    control.state = incoming.virtuoso;
    view.rerender(strictList([message(1), message(20), message(3)]));
    view.rerender(strictList([message(1), message(2), message(3)]));
    act(() => vi.runAllTimers());
    const root = screen.getByTestId("virtuoso-scroller");
    root.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    const secondRow = document.querySelector<HTMLElement>("[data-message-id='2']")!;
    act(() => {
      for (const observer of ControlledIntersectionObserver.instances) {
        observer.triggerStale(secondRow, 112);
      }
    });
    expect(onVisible).toHaveBeenCalledWith([2]);
    view.unmount();

    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({
      messageIds: incoming.messageIds,
      virtuoso: control.state,
    });
  });

  test("unmount before the positioning arm preserves the supplied snapshot", () => {
    const onSnapshot = vi.fn();
    const fallback: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 0 },
      messageIds: [1, 2, 3],
      anchorId: 1,
      anchorOffset: 0,
    };
    const incoming: ChatViewportSnapshot = {
      virtuoso: { ranges: [], scrollTop: 4960 },
      messageIds: [1, 2, 3],
      anchorId: 2,
      anchorOffset: -12,
    };
    const view = renderList({ onSnapshot, snapshot: incoming, fallbackSnapshot: fallback });

    view.unmount();

    expect(onSnapshot).not.toHaveBeenCalled();
  });

  test("cleanup captures message IDs changed immediately before unmount", () => {
    const onSnapshot = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const renderMessages = (messages: ClientChatMessage[]) =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
            <ChatList
              conversationKey="global"
              messages={messages}
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
    flushSync(() => renderMessages([message(1)]));
    flushSync(() => renderMessages([message(2)]));
    flushArm();
    root.unmount();
    host.remove();

    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({ messageIds: [2] });
  });

  test("conversation cleanup snapshots use the old IDs and callback", () => {
    const oldSnapshot = vi.fn();
    const newSnapshot = vi.fn();
    const view = renderList({ messages: [message(1)], onSnapshot: oldSnapshot });
    flushArm();
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
    flushArm();
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

  test("focus restoration reports rows that stayed intersecting while blurred", () => {
    const onVisible = vi.fn();
    renderList({ onVisible });
    flushArm();
    const observer = ControlledIntersectionObserver.instances[0]!;
    const firstRow = document.querySelector<HTMLElement>("[data-message-id='1']")!;
    const secondRow = document.querySelector<HTMLElement>("[data-message-id='2']")!;

    act(() => window.dispatchEvent(new Event("blur")));
    act(() => {
      observer.trigger(firstRow, 100, 1, true);
      observer.trigger(secondRow, 100, 0, false);
    });
    expect(onVisible).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event("focus")));
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onVisible).toHaveBeenCalledWith([1]);
  });

  test("visibility restoration reports retained rows only when focused", () => {
    const onVisible = vi.fn();
    renderList({ onVisible });
    flushArm();
    const observer = ControlledIntersectionObserver.instances[0]!;
    const row = document.querySelector<HTMLElement>("[data-message-id='1']")!;

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => observer.trigger(row, 100));
    expect(onVisible).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(onVisible).not.toHaveBeenCalled();

    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onVisible).toHaveBeenCalledWith([1]);
  });

  test("fresh parent visibility callbacks do not recreate observer or listeners", () => {
    const onVisible = vi.fn();
    function InlineParent() {
      const [, rerender] = useState(0);
      return (
        <ChatList
          conversationKey="global"
          messages={[message(1), message(2), message(3)]}
          identityCohort={[]}
          viewerId={viewerId}
          readState={{ readThrough: 0, seenAfter: [] }}
          jumpToLatestToken={0}
          emptyLabel="No messages"
          onSnapshot={vi.fn()}
          onVisible={() => {
            onVisible();
            rerender((value) => value + 1);
          }}
          onMarkThrough={vi.fn()}
        />
      );
    }
    render(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <InlineParent />
        </VirtuosoMockContext.Provider>
      </I18nextProvider>,
    );
    flushArm();
    const observer = ControlledIntersectionObserver.instances[0]!;
    const row = document.querySelector<HTMLElement>("[data-message-id='1']")!;

    act(() => observer.trigger(row, 100));
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(ControlledIntersectionObserver.instances).toHaveLength(1);
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
    renderList({
      firstItemIndex: 9,
      onMarkThrough,
      readState: { readThrough: 1, seenAfter: [] },
    });
    const up = screen.getByRole("button", { name: /Jump to first unread/ });
    fireEvent.click(up);
    expect(control.scrolls.at(-1)).toMatchObject({ index: 1, align: "start" });
    expect(onMarkThrough).not.toHaveBeenCalled();
  });

  test("success jump waits for a newly present row and then marks latest", () => {
    const onMarkThrough = vi.fn();
    const view = renderList({ firstItemIndex: 9, onMarkThrough, jumpToLatestToken: 0 });
    act(() => control.setAtBottom?.(false));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
          <ChatList
            conversationKey="global"
            firstItemIndex={9}
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
            firstItemIndex={9}
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
    expect(control.scrolls.at(-1)).toMatchObject({ index: 2, align: "end" });
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
