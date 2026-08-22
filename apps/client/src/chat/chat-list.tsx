import type { UserId } from "@werewolf/protocol";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  fallbackSnapshot?: ChatViewportSnapshot;
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
  fallbackSnapshot,
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
  const emitSnapshotRef = useRef<(() => boolean) | undefined>(undefined);
  const conversationEmitSnapshotRef = useRef<(() => boolean) | undefined>(undefined);
  const snapshotEpochRef = useRef(0);
  const snapshotCapturedRef = useRef(false);
  const visibleIdsRef = useRef(new Set<number>());
  const focusRef = useRef(
    (document.hasFocus?.() ?? true) && document.visibilityState === "visible",
  );
  const armedRef = useRef(false);
  const rafsRef = useRef<number[]>([]);
  const positioningRafsRef = useRef<number[]>([]);
  const conversationRef = useRef(conversationKey);
  const positionedConversationRef = useRef<string | null>(null);
  const exactRestoreIdsRef = useRef<number[] | undefined>(undefined);
  const previousToken = useRef(jumpToLatestToken);
  const pendingJumpToken = useRef<number | undefined>(undefined);
  const scheduledJump = useRef<{ conversationKey: string; token: number } | undefined>(undefined);
  const previousMessageIds = useRef<number[]>(messages.map((message) => message.id));
  const [atBottom, setAtBottom] = useState(true);
  const [isVisible, setIsVisible] = useState(document.visibilityState === "visible");
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [, setVisibilityVersion] = useState(0);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const fallbackSnapshotRef = useRef(fallbackSnapshot);
  fallbackSnapshotRef.current = fallbackSnapshot;

  const ids = useMemo(() => messages.map((message) => message.id), [messages]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
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
  } else if (messages.length === 0) {
    initialMessagesRef.current = false;
    frozenUnreadRef.current = undefined;
  } else if (!initialMessagesRef.current && messages.length > 0) {
    initialMessagesRef.current = true;
    frozenUnreadRef.current = oldestUnread;
  }
  const frozenUnread = frozenUnreadRef.current;
  const frozenMentioned = frozenUnread !== undefined && viewerMentionIds.has(frozenUnread);
  const exactSnapshotRestore =
    snapshot !== undefined && frozenUnread === undefined && sameIds(snapshot.messageIds, ids);
  const exactRestoreKey =
    exactSnapshotRestore && snapshot !== undefined
      ? JSON.stringify({
          conversationKey,
          messageIds: snapshot.messageIds,
          anchorId: snapshot.anchorId,
          anchorOffset: snapshot.anchorOffset,
          virtuoso: snapshot.virtuoso,
        })
      : undefined;
  const exactRestoreKeyRef = useRef(exactRestoreKey);
  exactRestoreKeyRef.current = exactRestoreKey;

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
    if (!armedRef.current || !focusRef.current || !isVisibleRef.current) return;
    const idsToReport = [...visibleIdsRef.current];
    if (idsToReport.length > 0) onVisibleRef.current(idsToReport);
  }, []);

  const setRowRef = useCallback((id: number, element: HTMLElement | null) => {
    const old = rowElements.current.get(id);
    if (old && old !== element) {
      observerRef.current?.unobserve(old);
      visibleIdsRef.current.delete(id);
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
    let observer: IntersectionObserver;
    observer = new IntersectionObserver(
      (entries) => {
        if (observerRef.current !== observer) return;
        for (const entry of entries) {
          if (conversationRef.current !== activeConversation) return;
          const target = entry.target as HTMLElement;
          const id = Number(target.dataset.messageId);
          if (!Number.isFinite(id)) continue;
          if (rowElements.current.get(id) !== target) continue;
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
      if (
        conversationRef.current !== activeConversation &&
        armedRef.current &&
        !snapshotCapturedRef.current
      ) {
        snapshotEpochRef.current += 1;
        snapshotCapturedRef.current = conversationEmitSnapshotRef.current?.() ?? false;
      }
      observer.disconnect();
      if (observerRef.current !== observer) return;
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
      isVisibleRef.current = visible;
      setIsVisible(visible);
      if (!visible) {
        focusRef.current = false;
        return;
      }
      focusRef.current = document.hasFocus?.() ?? true;
      reportVisible();
    };
    root.addEventListener("pointerdown", trusted);
    root.addEventListener("keydown", trusted);
    root.addEventListener("wheel", trusted);
    root.addEventListener("touchstart", trusted);
    window.addEventListener("blur", blur);
    const focus = () => {
      if (document.visibilityState === "visible") {
        focusRef.current = true;
        reportVisible();
      }
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
  }, [conversationKey, reportVisible, scrollerElement]);

  useEffect(() => {
    if (!scrollerElement || !hasMessages) return;
    conversationRef.current = conversationKey;
    armedRef.current = false;
    for (const frame of rafsRef.current) cancelAnimationFrame(frame);
    for (const frame of positioningRafsRef.current) cancelAnimationFrame(frame);
    positioningRafsRef.current = [];
    rafsRef.current = [
      requestAnimationFrame(() => {
        visibleIdsRef.current.clear();
        rafsRef.current.push(
          requestAnimationFrame(() => {
            if (!exactSnapshotRestore) armedRef.current = true;
          }),
        );
      }),
    ];
    return () => {
      for (const frame of rafsRef.current) cancelAnimationFrame(frame);
      rafsRef.current = [];
      for (const frame of positioningRafsRef.current) cancelAnimationFrame(frame);
      positioningRafsRef.current = [];
      armedRef.current = false;
    };
  }, [conversationKey, exactSnapshotRestore, hasMessages, scrollerElement]);

  const emitSnapshot = useCallback(
    (snapshotIds: number[] = ids) => {
      const virtuoso = virtuosoRef.current;
      if (!virtuoso) {
        const fallback = fallbackSnapshotRef.current;
        if (fallback) onSnapshot(fallback);
        return fallback !== undefined;
      }
      const epoch = snapshotEpochRef.current;
      let synchronous = true;
      let captured = false;
      virtuoso.getState((state) => {
        if (!synchronous || snapshotEpochRef.current !== epoch) return;
        captured = true;
        const viewport = scrollerRef.current?.getBoundingClientRect();
        const viewportTop = viewport?.top ?? 0;
        const viewportBottom = viewport?.bottom ?? viewportTop;
        const candidates = [...rowElements.current.entries()]
          .filter(([id]) => snapshotIds.includes(id))
          .map(([id, element]) => {
            const rect = element.getBoundingClientRect();
            return { id, top: rect.top, bottom: rect.bottom };
          })
          .filter(
            (candidate) =>
              candidate.bottom > candidate.top &&
              candidate.bottom > viewportTop &&
              candidate.top < viewportBottom,
          );
        const crossingTop = candidates
          .filter((candidate) => candidate.top < viewportTop && candidate.bottom > viewportTop)
          .sort((left, right) => right.top - left.top);
        const belowTop = candidates
          .filter((candidate) => candidate.top >= viewportTop)
          .sort((left, right) => left.top - right.top);
        const anchor = belowTop[0] ??
          crossingTop[0] ??
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
      synchronous = false;
      if (captured) return true;
      const fallback = fallbackSnapshotRef.current;
      if (fallback) onSnapshot(fallback);
      return fallback !== undefined;
    },
    [ids, onSnapshot],
  );

  emitSnapshotRef.current = () => emitSnapshot(idsRef.current);
  useEffect(() => {
    const activeConversation = conversationKey;
    conversationEmitSnapshotRef.current = () =>
      activeConversation.length > 0 ? emitSnapshot(ids) : false;
  }, [conversationKey, emitSnapshot, ids]);
  useLayoutEffect(() => {
    return () => {
      if (!snapshotCapturedRef.current && conversationRef.current.length > 0 && armedRef.current) {
        snapshotEpochRef.current += 1;
        snapshotCapturedRef.current = emitSnapshotRef.current?.() ?? false;
      }
    };
  }, []);
  useEffect(() => {
    const activeConversation = conversationKey;
    return () => {
      if (!snapshotCapturedRef.current && activeConversation.length > 0 && armedRef.current) {
        snapshotEpochRef.current += 1;
        snapshotCapturedRef.current = emitSnapshotRef.current?.() ?? false;
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
        index: index === "LAST" ? messages.length - 1 : index,
        align,
        offset,
        behavior,
      });
      if (mark) {
        const latest = messages[messages.length - 1]?.id;
        if (latest !== undefined) onMarkThrough(latest);
      }
    },
    [messages, onMarkThrough],
  );
  const scrollToRef = useRef(scrollTo);
  scrollToRef.current = scrollTo;

  const initialTarget = useMemo(() => {
    if (frozenUnread !== undefined)
      return messages.findIndex((message) => message.id === frozenUnread);
    if (snapshot && sameIds(snapshot.messageIds, ids)) return -1;
    if (snapshot && ids.includes(snapshot.anchorId))
      return messages.findIndex((message) => message.id === snapshot.anchorId);
    if (snapshot) return 0;
    if (messages.length > 0) return messages.length - 1;
    return -1;
  }, [frozenUnread, ids, messages, snapshot]);
  const initialTargetRef = useRef(initialTarget);
  initialTargetRef.current = initialTarget;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const positioningKey = JSON.stringify({
    conversationKey,
    ids,
    snapshot:
      snapshot === undefined
        ? undefined
        : {
            messageIds: snapshot.messageIds,
            anchorId: snapshot.anchorId,
            anchorOffset: snapshot.anchorOffset,
            virtuoso: snapshot.virtuoso,
          },
    hasOlder,
    frozenUnread,
    initialTarget,
  });
  const positioningKeyRef = useRef(positioningKey);
  positioningKeyRef.current = positioningKey;

  useEffect(() => {
    if (!scrollerElement || !hasMessages || exactRestoreKey === undefined) return;
    armedRef.current = false;
    for (const frame of positioningRafsRef.current) cancelAnimationFrame(frame);
    positioningRafsRef.current = [];
    const restoreAfterFrames = (remaining: number) => {
      const frame = requestAnimationFrame(() => {
        if (remaining > 1) {
          restoreAfterFrames(remaining - 1);
          return;
        }
        if (
          exactRestoreKeyRef.current !== exactRestoreKey ||
          conversationRef.current !== conversationKey
        )
          return;
        const currentSnapshot = snapshotRef.current;
        if (!currentSnapshot) return;
        if (scrollerRef.current) scrollerRef.current.scrollTop = currentSnapshot.virtuoso.scrollTop;
        positionedConversationRef.current = conversationKey;
        exactRestoreIdsRef.current = [...idsRef.current];
        const armAfterRestore = requestAnimationFrame(() => {
          const armFrame = requestAnimationFrame(() => {
            if (positionedConversationRef.current === conversationKey) armedRef.current = true;
          });
          positioningRafsRef.current.push(armFrame);
        });
        positioningRafsRef.current.push(armAfterRestore);
      });
      positioningRafsRef.current.push(frame);
    };
    restoreAfterFrames(5);
    return () => {
      for (const frame of positioningRafsRef.current) cancelAnimationFrame(frame);
      positioningRafsRef.current = [];
    };
  }, [conversationKey, exactRestoreKey, hasMessages, scrollerElement]);

  useEffect(() => {
    if (!scrollerElement || !hasMessages) return;
    const currentSnapshot = snapshotRef.current;
    const currentIds = idsRef.current;
    const currentFrozenUnread = frozenUnreadRef.current;
    const currentHasOlder = hasOlderRef.current;
    const currentInitialTarget = initialTargetRef.current;
    const exactRestoreDiverged =
      positionedConversationRef.current === conversationKey &&
      exactRestoreIdsRef.current !== undefined &&
      currentSnapshot !== undefined &&
      currentFrozenUnread === undefined &&
      !sameIds(exactRestoreIdsRef.current, currentIds);
    if (positionedConversationRef.current === conversationKey && !exactRestoreDiverged) return;
    const shouldRetrySnapshot =
      currentSnapshot !== undefined &&
      currentFrozenUnread === undefined &&
      !currentIds.includes(currentSnapshot.anchorId) &&
      currentHasOlder;
    const target = currentInitialTarget;
    if (target < 0) return;
    const frame = requestAnimationFrame(() => {
      if (
        positioningKeyRef.current !== positioningKey ||
        conversationRef.current !== conversationKey
      )
        return;
      const latestSnapshot = snapshotRef.current;
      const latestIds = idsRef.current;
      const latestFrozenUnread = frozenUnreadRef.current;
      const hasAnchor =
        latestFrozenUnread === undefined &&
        latestSnapshot !== undefined &&
        latestIds.includes(latestSnapshot.anchorId);
      if (!shouldRetrySnapshot) {
        positionedConversationRef.current = conversationKey;
        exactRestoreIdsRef.current = undefined;
      }
      const offset = hasAnchor && latestSnapshot ? latestSnapshot.anchorOffset : 0;
      scrollToRef.current(
        target,
        hasAnchor || latestFrozenUnread !== undefined || latestSnapshot !== undefined
          ? "start"
          : "end",
        offset,
        false,
        "auto",
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationKey, hasMessages, positioningKey, scrollerElement]);

  const resetJumpConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (resetJumpConversationRef.current === conversationKey) return;
    resetJumpConversationRef.current = conversationKey;
    previousMessageIds.current = [...jumpIdsRef.current];
    previousToken.current = latestJumpTokenRef.current;
    pendingJumpToken.current = undefined;
    scheduledJump.current = undefined;
  }, [conversationKey]);

  useEffect(() => {
    const previousLatest = previousMessageIds.current.at(-1);
    const latest = ids.at(-1);
    const appendedLatest =
      latest !== undefined &&
      (previousLatest === undefined
        ? previousMessageIds.current.length === 0
        : latest > previousLatest);
    const scheduledForCurrentToken =
      scheduledJump.current?.conversationKey === conversationKey &&
      scheduledJump.current.token === jumpToLatestToken;
    if (scheduledJump.current?.conversationKey === conversationKey && !scheduledForCurrentToken) {
      scheduledJump.current = undefined;
    }
    let shouldJump = scheduledForCurrentToken;
    if (jumpToLatestToken !== previousToken.current) {
      previousToken.current = jumpToLatestToken;
      if (appendedLatest) {
        pendingJumpToken.current = undefined;
        shouldJump = true;
      } else pendingJumpToken.current = jumpToLatestToken;
    } else if (pendingJumpToken.current !== undefined && appendedLatest) {
      pendingJumpToken.current = undefined;
      shouldJump = true;
    }
    previousMessageIds.current = [...ids];
    if (!shouldJump || messages.length === 0) return;
    pendingJumpToken.current = undefined;
    const request = { conversationKey, token: jumpToLatestToken };
    scheduledJump.current = request;
    const frame = requestAnimationFrame(() => {
      if (scheduledJump.current !== request) return;
      scheduledJump.current = undefined;
      scrollTo("LAST", "end", 0, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationKey, ids, jumpToLatestToken, messages.length, scrollTo]);

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
        initialTopMostItemIndex={initialTarget >= 0 ? initialTarget : undefined}
        itemContent={item}
        ref={virtuosoRef}
        {...(snapshot && sameIds(snapshot.messageIds, ids) && frozenUnread === undefined
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
