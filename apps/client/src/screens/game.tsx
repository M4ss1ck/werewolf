import type {
  EventId,
  GameEvent,
  GameplayCommand,
  PhaseId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { IdCard, MessageCircle, Moon, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { LiveGameConnection, type LiveStatus } from "../api/live.ts";
import { Chip, ErrorMessage, PhaseHeader, TabBar } from "../components.tsx";
import { Act } from "./act.tsx";
import { INTEL_KINDS, Me } from "./me.tsx";
import { Talk } from "./talk.tsx";
import { TIMELINE_KINDS, VillageTab } from "./village.tsx";

const TABS = [
  { id: "village", labelKey: "village", icon: Users },
  { id: "talk", labelKey: "talk", icon: MessageCircle },
  { id: "act", labelKey: "act", icon: Moon },
  { id: "me", labelKey: "me", icon: IdCard },
] as const;
type TabId = (typeof TABS)[number]["id"];
type EventTabId = "village" | "talk" | "me";

function maxEventId(events: GameEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.id), 0);
}

/** Design 06–09 · the in-game shell: phase header, four tabs, live wiring. */
export function GameScreen({
  initial,
  replay = false,
  onUpdate,
}: {
  initial: ViewerGameSnapshot;
  replay?: boolean;
  onUpdate: (next: ViewerGameSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState(initial);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connected");
  const [tab, setTab] = useState<TabId>("village");
  const [commandError, setCommandError] = useState<{
    phaseId: PhaseId | undefined;
    error: unknown;
  }>();
  // The newest event id each event tab has been shown. Null until the first
  // batch arrives, because that batch is the mount-time sync and backfill is
  // not "new" activity.
  const [lastSeen, setLastSeen] = useState<Record<EventTabId, number> | null>(null);
  useEffect(() => {
    const maxId = maxEventId(events);
    setLastSeen((current) => {
      if (current === null) {
        if (events.length === 0) return current;
        return { village: maxId, talk: maxId, me: maxId };
      }
      // Events landing on the open tab are seen as they land; opening a tab
      // marks its backlog seen.
      if (tab === "village" && maxId > current.village) return { ...current, village: maxId };
      if (tab === "talk" && maxId > current.talk) return { ...current, talk: maxId };
      if (tab === "me" && maxId > current.me) return { ...current, me: maxId };
      return current;
    });
  }, [events, tab]);
  useEffect(() => {
    if (replay) {
      void api.getReplay(initial.game.id).then((result) => {
        setSnapshot(result.snapshot);
        setEvents(result.events);
      });
      return;
    }
    // Subscribe from the start on mount so the sync frame backfills the full
    // event history (the lobby handoff may pass a latest-cursor snapshot); the
    // connection's own cursor, advanced by incoming frames, is what reconnects use.
    const connection = new LiveGameConnection(initial.game.id, 0 as EventId, {
      // The shell owns the status → screen choice, so a pushed finished game
      // must reach it: lift the snapshot up as well as keeping it local.
      onSnapshot: (next) => {
        setSnapshot(next);
        onUpdate(next);
      },
      onEvent: (event) => setEvents((current) => [...current, event]),
      onStatus: setStatus,
    });
    connection.connect();
    return () => connection.close();
    // The deps are the game id and the stable setter, not the `initial`
    // object: App re-renders this screen with a fresh snapshot on every push,
    // and an object dep would tear down and rebuild the socket each frame,
    // resubscribing from cursor 0 and re-delivering the whole history.
  }, [initial.game.id, onUpdate, replay]);
  const previousPhase = useRef(initial.game.phase?.id);
  useEffect(() => {
    const phaseId = snapshot.game.phase?.id;
    if (phaseId === undefined || previousPhase.current === phaseId) return;
    previousPhase.current = phaseId;
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
  }, [snapshot.game.phase?.id, snapshot.game.phase?.type, t]);
  const send = (command: Omit<GameplayCommand, "commandId">) =>
    api
      .postCommand(snapshot.game.id, command)
      .then(() => setCommandError(undefined))
      .catch((caught: unknown) => {
        setCommandError({ phaseId: snapshot.game.phase?.id, error: caught });
        throw caught;
      });
  // A stale command failure (e.g. PHASE_CLOSED from a deadline race) is
  // meaningless once the phase has moved on; only show it for its own phase.
  const shownCommandError =
    commandError?.phaseId === snapshot.game.phase?.id ? commandError?.error : undefined;
  // The Act tab is a call to action, not an event badge: alive and not yet
  // registered as having acted this phase, with an action on offer at night.
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
  const badges: Record<TabId, boolean> = {
    village:
      tab !== "village" &&
      lastSeen !== null &&
      events.some(
        (event) =>
          event.id > lastSeen.village && (TIMELINE_KINDS as readonly string[]).includes(event.kind),
      ),
    talk:
      tab !== "talk" &&
      lastSeen !== null &&
      events.some((event) => event.id > lastSeen.talk && event.kind === "chat.message"),
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
      {/* The phase header stays put; only the open tab scrolls under it. */}
      <div className="flex flex-col gap-5 px-4.5 pb-5 pt-6">
        {status === "reconnecting" && (
          <p className="flex justify-center">
            <Chip tone="running">{t("ui.reconnecting")}</Chip>
          </p>
        )}
        <ErrorMessage error={shownCommandError} />
        <PhaseHeader send={send} snapshot={snapshot} />
      </div>
      {/* Each tab owns its own scrolling so it can hold a footer — the vote
       * lock, the composer — against the tab bar. This wrapper keeps the tab
       * bar down there even on a phase where the Act tab renders nothing. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "village" && <VillageTab events={events} snapshot={snapshot} />}
        {tab === "talk" && <Talk events={events} send={send} snapshot={snapshot} />}
        {tab === "act" && <Act events={events} send={send} snapshot={snapshot} />}
        {tab === "me" && <Me events={events} send={send} snapshot={snapshot} />}
      </div>
      <TabBar
        current={tab}
        items={TABS.map((item) => ({
          id: item.id,
          label: t(`ui.tabs.${item.labelKey}`),
          icon: item.icon,
          badge: badges[item.id] ? { kind: "dot" } : undefined,
        }))}
        onSelect={(id) => setTab(id as TabId)}
      />
    </div>
  );
}
