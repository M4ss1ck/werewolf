import type { GameEvent, GameplayCommand, ViewerGameSnapshot } from "@werewolf/protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { LiveGameConnection, type LiveStatus } from "../api/live.ts";
import { Chip, PhaseHeader, TabBar } from "../components.tsx";
import { Act } from "./act.tsx";
import { Me } from "./me.tsx";
import { Talk } from "./talk.tsx";
import { VillageTab } from "./village.tsx";

const TABS = [
  { id: "village", labelKey: "village", glyph: "square" },
  { id: "talk", labelKey: "talk", glyph: "circle" },
  { id: "act", labelKey: "act", glyph: "diamond" },
  { id: "me", labelKey: "me", glyph: "circle" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Design 06–09 · the in-game shell: phase header, four tabs, live wiring. */
export function GameScreen({
  initial,
  replay = false,
}: {
  initial: ViewerGameSnapshot;
  replay?: boolean;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState(initial);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connected");
  const [tab, setTab] = useState<TabId>("village");
  useEffect(() => {
    if (replay) {
      void api.getReplay(initial.game.id).then((result) => {
        setSnapshot(result.snapshot);
        setEvents(result.events);
      });
      return;
    }
    const connection = new LiveGameConnection(initial.game.id, initial.cursor, {
      onSnapshot: setSnapshot,
      onEvent: (event) => setEvents((current) => [...current, event]),
      onStatus: setStatus,
    });
    connection.connect();
    return () => connection.close();
  }, [initial, replay]);
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
  const send = (command: Omit<GameplayCommand, "commandId">) => {
    void api.postCommand(snapshot.game.id, command).catch(() => undefined);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="screen__scroll flex flex-col gap-5 px-[18px] pb-5 pt-6">
        {status === "reconnecting" && (
          <p className="flex justify-center">
            <Chip tone="running">{t("ui.reconnecting")}</Chip>
          </p>
        )}
        <PhaseHeader snapshot={snapshot} />
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
          glyph: item.glyph,
        }))}
        onSelect={(id) => setTab(id as TabId)}
      />
    </div>
  );
}
