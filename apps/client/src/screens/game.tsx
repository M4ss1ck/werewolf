import type {
  ChatChannel,
  ChatContent,
  EventId,
  GameEvent,
  GameplayCommand,
  PhaseId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { CHAT_CHANNELS } from "@werewolf/protocol";
import { IdCard, MessageCircle, Moon, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { LiveGameConnection, type LiveStatus } from "../api/live.ts";
import type { ChatReadStoreController, ChatViewportSnapshot } from "../chat/index.ts";
import {
  type ChatDraft,
  type ConversationKey,
  EMPTY_CHAT_DRAFT,
  gameChatRows,
} from "../chat/model.ts";
import { unreadSummary } from "../chat/read-state.ts";
import { Chip, ErrorMessage, PhaseHeader, TabBar } from "../components.tsx";
import { Act } from "./act.tsx";
import { INTEL_KINDS, Me } from "./me.tsx";
import { type GameChatRecord, Talk } from "./talk.tsx";
import { TIMELINE_KINDS, VillageTab } from "./village.tsx";

const TABS = [
  { id: "village", labelKey: "village", icon: Users },
  { id: "talk", labelKey: "talk", icon: MessageCircle },
  { id: "act", labelKey: "act", icon: Moon },
  { id: "me", labelKey: "me", icon: IdCard },
] as const;
type TabId = (typeof TABS)[number]["id"];
type EventTabId = "village" | "me";
type PendingChatSend = {
  attemptId: number;
  beforeId: number;
  content: ChatContent;
  rowReceived: boolean;
  httpSettled: boolean;
  jumpRequested: boolean;
};

function maxEventId(events: readonly GameEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.id), 0);
}

function mergeEvents(current: readonly GameEvent[], incoming: readonly GameEvent[]): GameEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

function conversationKey(gameId: string, channel: ChatChannel): ConversationKey {
  return `game:${gameId}:${channel}` as ConversationKey;
}

function sameChatContent(left: ChatContent, right: ChatContent): boolean {
  return (
    left.text === right.text &&
    left.mentions.length === right.mentions.length &&
    left.mentions.every(
      (mention, index) =>
        mention.userId === right.mentions[index]?.userId &&
        mention.start === right.mentions[index]?.start &&
        mention.length === right.mentions[index]?.length,
    )
  );
}

function emptyRecords(): Record<ChatChannel, GameChatRecord> {
  return Object.fromEntries(
    CHAT_CHANNELS.map((channel) => [
      channel,
      { draft: EMPTY_CHAT_DRAFT, jumpToLatestToken: 0, viewport: undefined },
    ]),
  ) as unknown as Record<ChatChannel, GameChatRecord>;
}

/** Design 06–09 · the in-game shell: phase header, four tabs, live wiring. */
export function GameScreen({
  initial,
  replay = false,
  onUpdate,
  readStore,
}: {
  initial: ViewerGameSnapshot;
  replay?: boolean;
  onUpdate: (next: ViewerGameSnapshot) => void;
  readStore?: ChatReadStoreController;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState(initial);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connected");
  const [tab, setTab] = useState<TabId>("village");
  const [channel, setChannel] = useState<ChatChannel>("public");
  const [records, setRecords] = useState<Record<ChatChannel, GameChatRecord>>(emptyRecords);
  const [chatErrors, setChatErrors] = useState<Partial<Record<ChatChannel, unknown>>>({});
  const [commandError, setCommandError] = useState<{
    phaseId: PhaseId | undefined;
    error: unknown;
  }>();
  const [lastSeen, setLastSeen] = useState<Record<EventTabId, number> | null>(null);
  const [fallbackReads, setFallbackReads] = useState<Record<ChatChannel, number>>(
    () =>
      Object.fromEntries(CHAT_CHANNELS.map((currentChannel) => [currentChannel, 0])) as Record<
        ChatChannel,
        number
      >,
  );
  const eventsRef = useRef<GameEvent[]>([]);
  const snapshotRef = useRef(snapshot);
  const tabRef = useRef(tab);
  const readStoreRef = useRef(readStore);
  const initializedRef = useRef(false);
  const baselinedRef = useRef(new Set<string>());
  const pendingSendRef = useRef<Partial<Record<ChatChannel, PendingChatSend[]>>>({});
  const sendAttemptRef = useRef(0);
  const legacyEventCount = useRef(0);
  const legacyFirstWasChat = useRef(false);
  snapshotRef.current = snapshot;
  tabRef.current = tab;
  readStoreRef.current = readStore;

  const updateRecords = (
    update: (current: Record<ChatChannel, GameChatRecord>) => Record<ChatChannel, GameChatRecord>,
  ) => {
    setRecords((current) => {
      const next = update(current);
      return next;
    });
  };

  const bumpJumpToken = (channel: ChatChannel) => {
    updateRecords((current) => ({
      ...current,
      [channel]: {
        ...current[channel],
        jumpToLatestToken: current[channel].jumpToLatestToken + 1,
      },
    }));
  };

  const removePendingSend = (channel: ChatChannel, attemptId: number) => {
    const attempts = pendingSendRef.current[channel];
    if (attempts === undefined) return;
    const remaining = attempts.filter((attempt) => attempt.attemptId !== attemptId);
    if (remaining.length === 0) delete pendingSendRef.current[channel];
    else pendingSendRef.current[channel] = remaining;
  };

  const resolvePendingSend = (
    merged: readonly GameEvent[],
    players: ViewerGameSnapshot["players"],
    incoming: readonly GameEvent[],
    viewerId: UserId | undefined,
  ) => {
    const rows = gameChatRows(merged, players);
    for (const event of incoming) {
      if (event.kind !== "chat.message" || viewerId === undefined || event.actorUserId !== viewerId)
        continue;
      const channel = event.payload.channel;
      const pending = pendingSendRef.current[channel]?.find(
        (attempt) =>
          !attempt.rowReceived &&
          event.id > attempt.beforeId &&
          sameChatContent(attempt.content, event.payload),
      );
      const latest = rows[channel].at(-1)?.id;
      if (pending === undefined || latest === undefined || event.id <= pending.beforeId) continue;
      pending.rowReceived = true;
      readStoreRef.current?.markThrough(conversationKey(initial.game.id, channel), latest);
      if (!pending.jumpRequested) {
        pending.jumpRequested = true;
        bumpJumpToken(channel);
      }
      if (pending.httpSettled) removePendingSend(channel, pending.attemptId);
    }
  };

  const applySync = (nextSnapshot: ViewerGameSnapshot, incoming: readonly GameEvent[]) => {
    const merged = mergeEvents(eventsRef.current, incoming);
    eventsRef.current = merged;
    resolvePendingSend(merged, nextSnapshot.players, incoming, nextSnapshot.me?.userId);
    const rows = gameChatRows(merged, nextSnapshot.players);
    if (!readStoreRef.current && !initializedRef.current) {
      setFallbackReads((current) => ({
        ...current,
        ...Object.fromEntries(
          nextSnapshot.availableChannels.map((currentChannel) => [
            currentChannel,
            rows[currentChannel].at(-1)?.id ?? current[currentChannel],
          ]),
        ),
      }));
    }
    for (const available of nextSnapshot.availableChannels) {
      const key = conversationKey(nextSnapshot.game.id, available);
      if (
        readStoreRef.current &&
        !readStoreRef.current.hasRecord(key) &&
        !baselinedRef.current.has(key)
      ) {
        baselinedRef.current.add(key);
        readStoreRef.current.establishBaseline(key, rows[available]);
      }
    }
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    setEvents(merged);
    onUpdate(nextSnapshot);
    if (!initializedRef.current) {
      initializedRef.current = true;
      const max = maxEventId(merged);
      setLastSeen({ village: max, me: max });
    } else {
      setLastSeen((current) => {
        if (current === null) return current;
        const max = maxEventId(incoming);
        if (max === 0) return current;
        return {
          village: tabRef.current === "village" ? Math.max(current.village, max) : current.village,
          me: tabRef.current === "me" ? Math.max(current.me, max) : current.me,
        };
      });
    }
  };

  const applyEvent = (event: GameEvent) => {
    const merged = mergeEvents(eventsRef.current, [event]);
    eventsRef.current = merged;
    resolvePendingSend(
      merged,
      snapshotRef.current.players,
      [event],
      snapshotRef.current.me?.userId,
    );
    setEvents(merged);
    if (!initializedRef.current) {
      // Compatibility for older adapters which delivered the initial sync
      // through individual callbacks. The real connection uses onSync.
      legacyEventCount.current += 1;
      if (legacyEventCount.current === 1) {
        legacyFirstWasChat.current = event.kind === "chat.message";
        if (!legacyFirstWasChat.current) initializedRef.current = true;
      } else if (legacyFirstWasChat.current && legacyEventCount.current >= 3) {
        initializedRef.current = true;
      }
      if (
        !readStoreRef.current &&
        legacyFirstWasChat.current &&
        legacyEventCount.current <= 2 &&
        event.kind === "chat.message"
      ) {
        setFallbackReads((current) => ({ ...current, [event.payload.channel]: event.id }));
      }
      if (!initializedRef.current) setLastSeen({ village: event.id, me: event.id });
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: connection lifecycle is intentionally stable per game
  useEffect(() => {
    if (replay) {
      void api
        .getReplay(initial.game.id)
        .then((result) => applySync(result.snapshot, result.events));
      return;
    }
    const connection = new LiveGameConnection(initial.game.id, 0 as EventId, {
      onSync: applySync,
      onSnapshot: (next) => {
        eventsRef.current = [];
        baselinedRef.current.clear();
        initializedRef.current = false;
        legacyEventCount.current = 0;
        legacyFirstWasChat.current = false;
        setEvents([]);
        setLastSeen(null);
        setFallbackReads(
          Object.fromEntries(CHAT_CHANNELS.map((currentChannel) => [currentChannel, 0])) as Record<
            ChatChannel,
            number
          >,
        );
        setSnapshot(next);
        snapshotRef.current = next;
        onUpdate(next);
      },
      onEvent: applyEvent,
      onStatus: setStatus,
    });
    connection.connect();
    return () => connection.close();
    // The socket is keyed only by game identity and replay mode.
  }, [initial.game.id, onUpdate, replay]);

  useEffect(() => {
    if (snapshot.availableChannels.includes(channel)) return;
    setChannel("public");
  }, [channel, snapshot.availableChannels]);

  useEffect(() => {
    const phaseId = snapshot.game.phase?.id;
    if (phaseId === undefined || phaseId === initial.game.phase?.id) return;
    if (localStorage.getItem("werewolf.prefs.notifications") !== "true") return;
    if (!("Notification" in window)) return;
    const show = () =>
      new Notification(
        t("events.public.phase.started", { phase: t(`phases.${snapshot.game.phase?.type}`) }),
      );
    if (Notification.permission === "granted") show();
    else if (Notification.permission === "default")
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") show();
      });
  }, [initial.game.phase?.id, snapshot.game.phase?.id, snapshot.game.phase?.type, t]);

  const send = (command: Omit<GameplayCommand, "commandId">) =>
    api
      .postCommand(snapshot.game.id, command)
      .then(() => setCommandError(undefined))
      .catch((caught: unknown) => {
        setCommandError({ phaseId: snapshot.game.phase?.id, error: caught });
        throw caught;
      });

  const sendTalk = async (content: ChatContent) => {
    const phase = snapshotRef.current.game.phase;
    if (phase === null) throw new Error("PHASE_CLOSED");
    const rows = gameChatRows(eventsRef.current, snapshotRef.current.players)[channel];
    const pending: PendingChatSend = {
      attemptId: ++sendAttemptRef.current,
      beforeId: rows.at(-1)?.id ?? 0,
      content,
      rowReceived: false,
      httpSettled: false,
      jumpRequested: false,
    };
    pendingSendRef.current[channel] = [...(pendingSendRef.current[channel] ?? []), pending];
    try {
      await send({ type: "chat.send", phaseId: phase.id, payload: { channel, ...content } });
      pending.httpSettled = true;
      if (pending.rowReceived) removePendingSend(channel, pending.attemptId);
      setChatErrors((current) => ({ ...current, [channel]: undefined }));
    } catch (error) {
      removePendingSend(channel, pending.attemptId);
      setChatErrors((current) => ({ ...current, [channel]: error }));
      throw error;
    }
  };

  const me = snapshot.me;
  const phase = snapshot.game.phase;
  let actPending = false;
  if (me?.status === "alive" && phase?.type === "voting") {
    actPending = me.currentIntent?.vote === undefined;
  } else if (me?.status === "alive" && phase?.type === "night") {
    actPending =
      snapshot.availableActions.length > 0 &&
      Object.keys(me.currentIntent?.actions ?? {}).length === 0;
  }
  const rows = gameChatRows(events, snapshot.players);
  const unread = snapshot.availableChannels.reduce(
    (summary, currentChannel) => {
      const state = readStore?.states[conversationKey(snapshot.game.id, currentChannel)] ?? {
        readThrough: fallbackReads[currentChannel] ?? 0,
        seenAfter: [],
      };
      const next = unreadSummary(state, rows[currentChannel], snapshot.me?.userId ?? ("" as never));
      return { count: summary.count + next.count, mentioned: summary.mentioned || next.mentioned };
    },
    { count: 0, mentioned: false },
  );
  const shownCommandError =
    tab !== "talk" && commandError && commandError.phaseId === snapshot.game.phase?.id
      ? commandError.error
      : undefined;
  const badges = {
    village:
      tab !== "village" &&
      lastSeen !== null &&
      events.some(
        (event) =>
          event.id > lastSeen.village && (TIMELINE_KINDS as readonly string[]).includes(event.kind),
      ),
    talk: unread.count > 0,
    act: tab !== "act" && actPending,
    me:
      tab !== "me" &&
      lastSeen !== null &&
      events.some(
        (event) =>
          event.id > lastSeen.me && (INTEL_KINDS as readonly string[]).includes(event.kind),
      ),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-5 px-4.5 pb-5 pt-6">
        {status === "reconnecting" && (
          <p className="flex justify-center">
            <Chip tone="running">{t("ui.reconnecting")}</Chip>
          </p>
        )}
        <ErrorMessage error={shownCommandError} />
        <PhaseHeader send={send} snapshot={snapshot} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "village" && <VillageTab events={events} snapshot={snapshot} />}
        {tab === "talk" && (
          <Talk
            activeChannel={channel}
            chatRows={rows}
            errors={chatErrors}
            onChannelChange={setChannel}
            onDraftChange={(next: ChatDraft) =>
              updateRecords((current) => ({
                ...current,
                [channel]: { ...current[channel], draft: next },
              }))
            }
            onError={(error) => setChatErrors((current) => ({ ...current, [channel]: error }))}
            onMarkThrough={(latest) =>
              readStore?.markThrough(conversationKey(snapshot.game.id, channel), latest)
            }
            onSend={sendTalk}
            onSnapshot={(next: ChatViewportSnapshot) =>
              updateRecords((current) => ({
                ...current,
                [channel]: { ...current[channel], viewport: next },
              }))
            }
            onVisible={(ids) =>
              readStore?.markVisible(conversationKey(snapshot.game.id, channel), rows[channel], ids)
            }
            {...(readStore === undefined ? {} : { readStore })}
            records={records}
            snapshot={snapshot}
          />
        )}
        {tab === "act" && <Act events={events} send={send} snapshot={snapshot} />}
        {tab === "me" && <Me events={events} send={send} snapshot={snapshot} />}
      </div>
      <TabBar
        current={tab}
        items={TABS.map((item) => ({
          id: item.id,
          label: t(`ui.tabs.${item.labelKey}`),
          icon: item.icon,
          badge: badges[item.id]
            ? item.id === "talk"
              ? { kind: "count", count: unread.count, mentioned: unread.mentioned }
              : { kind: "dot" }
            : undefined,
        }))}
        onSelect={(id) => {
          setTab(id as TabId);
          if (id === "village" || id === "me") {
            const max = maxEventId(eventsRef.current);
            setLastSeen((current) => (current ? { ...current, [id]: max } : current));
          }
        }}
      />
    </div>
  );
}
