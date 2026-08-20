import type { GameEvent, ViewerGameSnapshot } from "@werewolf/protocol";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Avatar } from "../components.tsx";

export const TIMELINE_KINDS = [
  "player.eliminated",
  "vote.resolved",
  "night.resolved",
  "phase.started",
] as const;
type TimelineEvent = Extract<GameEvent, { kind: (typeof TIMELINE_KINDS)[number] }>;

function isTimelineEvent(event: GameEvent): event is TimelineEvent {
  return (TIMELINE_KINDS as readonly string[]).includes(event.kind);
}

function eventLine(event: TimelineEvent, names: Map<string, string>, t: TFunction): string {
  switch (event.kind) {
    case "player.eliminated":
      return t("events.public.player.eliminated", {
        player: names.get(event.payload.playerId) ?? event.payload.playerId,
        role: t(`roles.${event.payload.role}.name`),
      });
    case "vote.resolved":
      return t("events.public.vote.resolved", {
        abstain: event.payload.abstain,
        noVote: event.payload.noVote,
      });
    case "night.resolved":
      return t("events.public.night.resolved.count", { count: event.payload.deaths.length });
    case "phase.started":
      return t("events.public.phase.started", { phase: t(`phases.${event.payload.type}`) });
  }
}

/** The in-game "Village" tab: who is in the village and what has happened. */
export function VillageTab({
  snapshot,
  events,
}: {
  snapshot: ViewerGameSnapshot;
  events: GameEvent[];
}) {
  const { t } = useTranslation();
  const villagers = snapshot.players.filter(
    (player) => player.status === "alive" || player.status === "dead",
  );
  const alive = villagers.filter((player) => player.status === "alive").length;
  const timeline = events.filter(isTimelineEvent);
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  return (
    <div className="screen__scroll flex flex-col gap-6 px-4.5 pb-5">
      <section className="flex flex-col gap-3">
        <p className="eyebrow">{t("ui.intel.villageAlive.count", { count: alive })}</p>
        <div className="grid grid-cols-5 gap-x-2 gap-y-3">
          {villagers.map((player) => {
            const dead = player.status === "dead";
            return (
              <div className="flex flex-col items-center gap-1.5" key={player.userId}>
                <Avatar dead={dead} name={player.displayName} size="lg" />
                <span
                  className={`max-w-full truncate text-center text-[11px] ${
                    dead ? "text-fog-dim line-through" : "text-fog"
                  }`}
                >
                  {player.displayName}
                </span>
              </div>
            );
          })}
        </div>
      </section>
      {timeline.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <ul className="flex flex-col gap-2">
            {timeline.map((event) => (
              <li
                className="flex flex-col gap-1.5 rounded-[14px] border border-paper/10 bg-surface px-3.5 py-3"
                key={event.id}
              >
                <time className="eyebrow" dateTime={new Date(event.createdAt).toISOString()}>
                  {new Date(event.createdAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <p className="text-sm text-paper-dim">{eventLine(event, names, t)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
