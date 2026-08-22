import type { UserId } from "@werewolf/protocol";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type StateSnapshot, Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { DividerNote } from "../components.tsx";
import { ChatBubble, hasValidatedViewerMention } from "./chat-components.tsx";
import { allocateIdentityMarks } from "./identity.tsx";
import type { MentionCandidate } from "./mentions.ts";
import type { ClientChatMessage, ConversationKey } from "./model.ts";
import { type ConversationReadState, unreadSummary } from "./read-state.ts";

export type ChatViewportSnapshot = {
  virtuoso: StateSnapshot;
  messageIds: number[];
  anchorId: number;
  anchorOffset: number;
};

export type ChatListProps = {
  conversationKey: ConversationKey;
  messages: ClientChatMessage[];
  identityCohort: MentionCandidate[];
  viewerId: UserId;
  readState: ConversationReadState;
  firstItemIndex?: number;
  hasOlder?: boolean;
  historyTruncated?: boolean;
  jumpToLatestToken: number;
  emptyLabel: string;
  snapshot?: ChatViewportSnapshot;
  onSnapshot(snapshot: ChatViewportSnapshot): void;
  onVisible(ids: number[]): void;
  onMarkThrough(latestId: number): void;
  onLoadOlder?(): void;
};

type RowRect = { id: number; top: number; bottom: number };

function motionBehavior(): "auto" | "smooth" {
  if (localStorage.getItem("werewolf.prefs.reducedMotion") === "true") return "auto";
  if (document.documentElement.dataset.reducedMotion === "true") return "auto";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "auto";
  return "smooth";
}

function countLabel(count: number): string {
  return count <= 99 ? String(count) : "99+";
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function ChatList({
  conversationKey,
  messages,
  identityCohort,
  viewerId,
  readState,
  firstItemIndex = 0,
  hasOlder = false,
  historyTruncated = false,
  jumpToLatestToken,
  emptyLabel,
  snapshot,
  onSnapshot,
  onVisible,
  onMarkThrough,
  onLoadOlder,
}: ChatListProps) {
  const { t } = useTranslation();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rowElements = useRef(new Map<number, HTMLElement>());
  const rowRefCallbacks = useRef(new Map<number, (element: HTMLElement | null) => void>());
  const rowRects = useRef(new Map<number, RowRect>());
  const emitSnapshotRef = useRef<(() => void) | undefined>(undefined);
  const snapshotCapturedRef = useRef(false);
  const visibleIdsRef = useRef(new Set<number>());
  const focusRef = useRef(
    (document.hasFocus?.() ?? true) && document.visibilityState === "visible",
  );
  const armedRef = useRef(false);
  const rafsRef = useRef<number[]>([]);
  const conversationRef = useRef(conversationKey);
  const positionedConversationRef = useRef<string | null>(null);
  const previousToken = useRef(jumpToLatestToken);
  const pendingJumpToken = useRef<number | undefined>(undefined);
  const previousMessageIds = useRef<number[]>(messages.map((message) => message.id));
  const [atBottom, setAtBottom] = useState(true);
  const [isVisible, setIsVisible] = useState(document.visibilityState === "visible");
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [, setVisibilityVersion] = useState(0);

  const ids = useMemo(() => messages.map((message) => message.id), [messages]);
  const hasMessages = messages.length > 0;
  const jumpIdsRef = useRef(ids);
  jumpIdsRef.current = ids;
  const latestJumpTokenRef = useRef(jumpToLatestToken);
  latestJumpTokenRef.current = jumpToLatestToken;
  const unread = useMemo(
    () => unreadSummary(readState, messages, viewerId),
    [readState, messages, viewerId],
  );
  const viewerMentionIds = useMemo(
    () =>
      new Set(
        messages
          .filter((message) => hasValidatedViewerMention(message.text, message.mentions, viewerId))
          .map((message) => message.id),
      ),
    [messages, viewerId],
  );
  const oldestUnread = unread.ids[0];
  const initialMessagesRef = useRef(messages.length > 0);
  const frozenUnreadRef = useRef<number | undefined>(oldestUnread);
  if (conversationRef.current !== conversationKey) {
    conversationRef.current = conversationKey;
    initialMessagesRef.current = messages.length > 0;
    frozenUnreadRef.current = oldestUnread;
  } else if (!initialMessagesRef.current && messages.length > 0) {
    initialMessagesRef.current = true;
    frozenUnreadRef.current = oldestUnread;
  }
  const frozenUnread = frozenUnreadRef.current;
  const frozenMentioned = frozenUnread !== undefined && viewerMentionIds.has(frozenUnread);

  const marks = useMemo(() => {
    const participants = [...identityCohort];
    for (const message of messages) {
      if (!participants.some((participant) => participant.userId === message.authorId)) {
        participants.push({ userId: message.authorId, displayName: message.displayName });
      }
    }
    return allocateIdentityMarks(participants);
  }, [identityCohort, messages]);

  const reportVisible = useCallback(() => {
    if (!armedRef.current || !focusRef.current || !isVisible) return;
    const idsToReport = [...visibleIdsRef.current];
    if (idsToReport.length > 0) onVisible(idsToReport);
  }, [isVisible, onVisible]);

  const setRowRef = useCallback((id: number, element: HTMLElement | null) => {
    const old = rowElements.current.get(id);
    if (old && old !== element) {
      observerRef.current?.unobserve(old);
      rowRects.current.delete(id);
    }
    if (element) {
      rowElements.current.set(id, element);
      observerRef.current?.observe(element);
    } else {
      rowElements.current.delete(id);
      visibleIdsRef.current.delete(id);
      rowRects.current.delete(id);
      rowRefCallbacks.current.delete(id);
    }
  }, []);

  const rowRefFor = useCallback(
    (id: number) => {
      const existing = rowRefCallbacks.current.get(id);
      if (existing) return existing;
      const callback = (element: HTMLElement | null) => setRowRef(id, element);
      rowRefCallbacks.current.set(id, callback);
      return callback;
    },
    [setRowRef],
  );

  useEffect(() => {
    const root = scrollerElement;
    if (!root) return;
    const activeConversation = conversationKey;
    observerRef.current?.disconnect();
    visibleIdsRef.current.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (conversationRef.current !== activeConversation) return;
          const id = Number((entry.target as HTMLElement).dataset.messageId);
          if (!Number.isFinite(id)) continue;
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            visibleIdsRef.current.add(id);
            rowRects.current.set(id, {
              id,
              top: entry.boundingClientRect.top,
              bottom: entry.boundingClientRect.bottom,
            });
          } else {
            visibleIdsRef.current.delete(id);
            rowRects.current.delete(id);
          }
        }
        setVisibilityVersion((version) => version + 1);
        reportVisible();
      },
      { root },
    );
    observerRef.current = observer;
    for (const element of rowElements.current.values()) observer.observe(element);
    return () => {
      if (conversationRef.current !== activeConversation) {
        emitSnapshotRef.current?.();
        snapshotCapturedRef.current = true;
      }
      observer.disconnect();
      observerRef.current = null;
      visibleIdsRef.current.clear();
      rowRects.current.clear();
    };
  }, [conversationKey, reportVisible, scrollerElement]);

  useEffect(() => {
    const root = scrollerElement;
    if (!root) return;
    const activeConversation = conversationKey;
    const trusted = (event: Event) => {
      if (conversationRef.current !== activeConversation) return;
      if (!event.isTrusted) return;
      if (event.target === root || root.contains(event.target as Node)) focusRef.current = true;
    };
    const blur = () => {
      focusRef.current = false;
    };
    const visibility = () => {
      const visible = document.visibilityState === "visible";
      setIsVisible(visible);
      if (!visible) focusRef.current = false;
      else focusRef.current = document.hasFocus?.() ?? true;
    };
    root.addEventListener("pointerdown", trusted);
    root.addEventListener("keydown", trusted);
    root.addEventListener("wheel", trusted);
    root.addEventListener("touchstart", trusted);
    window.addEventListener("blur", blur);
    const focus = () => {
      if (document.visibilityState === "visible") focusRef.current = true;
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      root.removeEventListener("pointerdown", trusted);
      root.removeEventListener("keydown", trusted);
      root.removeEventListener("wheel", trusted);
      root.removeEventListener("touchstart", trusted);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [conversationKey, scrollerElement]);

  useEffect(() => {
    if (!scrollerElement || !hasMessages) return;
    conversationRef.current = conversationKey;
    armedRef.current = false;
    for (const frame of rafsRef.current) cancelAnimationFrame(frame);
    rafsRef.current = [
      requestAnimationFrame(() => {
        visibleIdsRef.current.clear();
        rafsRef.current.push(
          requestAnimationFrame(() => {
            armedRef.current = true;
          }),
        );
      }),
    ];
    return () => {
      for (const frame of rafsRef.current) cancelAnimationFrame(frame);
      rafsRef.current = [];
      armedRef.current = false;
    };
  }, [conversationKey, hasMessages, scrollerElement]);

  const emitSnapshot = useCallback(() => {
    virtuosoRef.current?.getState((state) => {
      const viewportTop = scrollerRef.current?.getBoundingClientRect().top ?? 0;
      const snapshotIds = ids;
      const candidates = [...rowRects.current.values()].filter((candidate) =>
        snapshotIds.includes(candidate.id),
      );
      const crossingTop = candidates
        .filter((candidate) => candidate.top < viewportTop && candidate.bottom > viewportTop)
        .sort((left, right) => right.top - left.top);
      const belowTop = candidates
        .filter((candidate) => candidate.top >= viewportTop)
        .sort((left, right) => left.top - right.top);
      const anchor = crossingTop[0] ??
        belowTop[0] ??
        candidates.sort((left, right) => right.top - left.top)[0] ?? {
          id:
            [...rowElements.current.keys()].find((id) => snapshotIds.includes(id)) ??
            snapshotIds[0] ??
            0,
          top: viewportTop,
          bottom: viewportTop,
        };
      onSnapshot({
        virtuoso: state,
        messageIds: [...snapshotIds],
        anchorId: anchor.id,
        anchorOffset: anchor.top - viewportTop,
      });
    });
  }, [ids, onSnapshot]);

  useEffect(() => {
    emitSnapshotRef.current = emitSnapshot;
  }, [emitSnapshot]);
  useEffect(() => {
    const activeConversation = conversationKey;
    return () => {
      if (!snapshotCapturedRef.current && activeConversation.length > 0) {
        emitSnapshotRef.current?.();
      }
      snapshotCapturedRef.current = false;
      visibleIdsRef.current.clear();
      rowRects.current.clear();
    };
  }, [conversationKey]);

  const scrollTo = useCallback(
    (
      index: number | "LAST",
      align: "start" | "end" = "start",
      offset = 0,
      mark = false,
      behavior = motionBehavior(),
    ) => {
      if (index === "LAST" ? messages.length === 0 : index < 0 || index >= messages.length) return;
      virtuosoRef.current?.scrollToIndex({
        index: index === "LAST" ? firstItemIndex + messages.length - 1 : firstItemIndex + index,
        align,
        offset,
        behavior,
      });
      if (mark) {
        const latest = messages[messages.length - 1]?.id;
        if (latest !== undefined) onMarkThrough(latest);
      }
    },
    [firstItemIndex, messages, onMarkThrough],
  );

  const initialTarget = useMemo(() => {
    if (oldestUnread !== undefined)
      return messages.findIndex((message) => message.id === oldestUnread);
    if (snapshot && sameIds(snapshot.messageIds, ids)) return -1;
    if (snapshot && ids.includes(snapshot.anchorId))
      return messages.findIndex((message) => message.id === snapshot.anchorId);
    if (snapshot) return 0;
    if (messages.length > 0) return messages.length - 1;
    return -1;
  }, [ids, messages, oldestUnread, snapshot]);

  useEffect(() => {
    if (
      !scrollerElement ||
      positionedConversationRef.current === conversationKey ||
      messages.length === 0
    )
      return;
    positionedConversationRef.current = conversationKey;
    if (initialTarget < 0 || (snapshot && sameIds(snapshot.messageIds, ids))) return;
    const frame = requestAnimationFrame(() => {
      const hasAnchor = snapshot !== undefined && ids.includes(snapshot.anchorId);
      const offset = hasAnchor ? snapshot.anchorOffset : 0;
      scrollTo(
        initialTarget,
        hasAnchor || oldestUnread !== undefined || snapshot !== undefined ? "start" : "end",
        offset,
        false,
        "auto",
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    conversationKey,
    ids,
    initialTarget,
    messages.length,
    oldestUnread,
    scrollTo,
    scrollerElement,
    snapshot,
  ]);

  const resetJumpConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (resetJumpConversationRef.current === conversationKey) return;
    resetJumpConversationRef.current = conversationKey;
    previousMessageIds.current = [...jumpIdsRef.current];
    previousToken.current = latestJumpTokenRef.current;
    pendingJumpToken.current = undefined;
  }, [conversationKey]);

  useEffect(() => {
    const previousLatest = previousMessageIds.current.at(-1);
    const latest = ids.at(-1);
    const appendedLatest =
      previousLatest !== undefined && latest !== undefined && latest > previousLatest;
    let shouldJump = false;
    if (jumpToLatestToken !== previousToken.current) {
      previousToken.current = jumpToLatestToken;
      if (appendedLatest) shouldJump = true;
      else pendingJumpToken.current = jumpToLatestToken;
    } else if (pendingJumpToken.current !== undefined && appendedLatest) {
      pendingJumpToken.current = undefined;
      shouldJump = true;
    }
    previousMessageIds.current = [...ids];
    if (!shouldJump || messages.length === 0) return;
    const frame = requestAnimationFrame(() => scrollTo("LAST", "end", 0, true));
    return () => cancelAnimationFrame(frame);
  }, [ids, jumpToLatestToken, messages.length, scrollTo]);

  const greatestVisibleIndex = Math.max(
    ...[...visibleIdsRef.current].map((id) => ids.indexOf(id)),
    -1,
  );
  const belowUnread = unread.ids.filter((id) => ids.indexOf(id) > greatestVisibleIndex);
  const belowCount = belowUnread.length;
  const belowMentioned = belowUnread.some((id) => viewerMentionIds.has(id));
  const unreadMentioned = unread.ids.some((id) => viewerMentionIds.has(id));
  const firstUnreadIndex = oldestUnread === undefined ? -1 : ids.indexOf(oldestUnread);
  const item = (_index: number, message: ClientChatMessage) => {
    const divider = message.id === frozenUnread;
    const mark = marks.get(message.authorId);
    return (
      <div className="chat-list__row" data-message-id={message.id} ref={rowRefFor(message.id)}>
        {divider && (
          <DividerNote>{frozenMentioned ? t("ui.mentionedYou") : t("ui.unread")}</DividerNote>
        )}
        <ChatBubble
          author={message.displayName}
          authorId={message.authorId}
          mentions={message.mentions}
          mine={message.authorId === viewerId}
          text={message.text}
          viewerId={viewerId}
          identityMarks={marks}
        />
        {mark && <span className="sr-only">{mark.accessibleLabel}</span>}
      </div>
    );
  };

  const handleScrollerRef = useCallback((element: HTMLElement | Window | null) => {
    const next = element instanceof HTMLElement ? element : null;
    if (scrollerRef.current === next) return;
    scrollerRef.current = next;
    if (!next) rowRects.current.clear();
    setScrollerElement(next);
  }, []);

  useEffect(() => {
    if (!hasMessages && scrollerElement !== null) {
      scrollerRef.current = null;
      rowRects.current.clear();
      setScrollerElement(null);
    }
  }, [hasMessages, scrollerElement]);

  useEffect(() => {
    if (!hasMessages) positionedConversationRef.current = null;
  }, [hasMessages]);

  if (messages.length === 0) {
    return (
      <div className="chat-list chat-list--empty">
        <p className="text-sm text-fog">{emptyLabel}</p>
        {historyTruncated && (
          <p className="text-sm text-fog">{t("ui.earlierMessagesUnavailable")}</p>
        )}
      </div>
    );
  }

  return (
    <div className="chat-list">
      <Virtuoso
        atBottomStateChange={setAtBottom}
        className="global-chat-scrollbar flex-1"
        computeItemKey={(_index, message) => message.id}
        data={messages}
        firstItemIndex={firstItemIndex}
        followOutput={(isAtBottom) => (isAtBottom ? motionBehavior() : false)}
        initialTopMostItemIndex={initialTarget >= 0 ? firstItemIndex + initialTarget : undefined}
        itemContent={item}
        ref={virtuosoRef}
        {...(snapshot && sameIds(snapshot.messageIds, ids) && oldestUnread === undefined
          ? { restoreStateFrom: snapshot.virtuoso }
          : {})}
        scrollerRef={handleScrollerRef}
        startReached={() => {
          if (hasOlder) onLoadOlder?.();
        }}
      />
      {historyTruncated && (
        <p className="chat-list__boundary">{t("ui.earlierMessagesUnavailable")}</p>
      )}
      {!atBottom && (
        <button
          aria-label={`${t("ui.jumpToLatest")}${belowCount > 0 ? `, ${t("ui.unreadMessages", { count: belowCount })}` : ""}${belowMentioned ? `, ${t("ui.mentionedYou")}` : ""}`}
          className="chat-list__nav"
          onClick={() => scrollTo("LAST", "end", 0, true)}
          type="button"
        >
          {belowCount > 0 && (
            <span aria-hidden="true" className="chat-list__count">
              {countLabel(belowCount)}
            </span>
          )}
          <ChevronDown aria-hidden="true" size={20} />
        </button>
      )}
      {atBottom && unread.count > 0 && (
        <button
          aria-label={`${t("ui.jumpToFirstUnread")}, ${t("ui.unreadMessages", { count: unread.count })}${unreadMentioned ? `, ${t("ui.mentionedYou")}` : ""}`}
          className="chat-list__nav"
          onClick={() => scrollTo(firstUnreadIndex)}
          type="button"
        >
          <span aria-hidden="true" className="chat-list__count">
            {countLabel(unread.count)}
          </span>
          <ChevronUp aria-hidden="true" size={20} />
        </button>
      )}
    </div>
  );
}
