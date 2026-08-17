import type { GameEvent, ViewerGameSnapshot } from "@werewolf/protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { Avatar } from "../components.tsx";
import { navigate } from "../routes.tsx";

export function GameOverScreen({
  snapshot,
  events,
  replay = false,
}: {
  snapshot: ViewerGameSnapshot;
  events?: GameEvent[];
  /** True on the replay route, where "watch replay" would lead back here. */
  replay?: boolean;
}) {
  const { t } = useTranslation();
  const [loadedEvents, setLoadedEvents] = useState<GameEvent[]>(events ?? []);
  useEffect(() => {
    if (events !== undefined) return;
    void api.getReplay(snapshot.game.id).then((result) => setLoadedEvents(result.events));
  }, [events, snapshot.game.id]);
  const winner = snapshot.game.winner;
  const wolvesWon = winner?.winningFactions.includes("wolves") ?? false;
  const publicEvents = loadedEvents.filter((event) => event.scope === "public");
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  const line = (event: GameEvent) => {
    switch (event.kind) {
      case "player.eliminated":
        return t("events.public.player.eliminated", {
          player: names.get(event.payload.playerId) ?? event.payload.playerId,
          role: t(`roles.${event.payload.role}.name`),
        });
      case "phase.started":
        return t("events.public.phase.started", { phase: t(`phases.${event.payload.type}`) });
      case "vote.resolved":
        return t("events.public.vote.resolved", event.payload);
      case "night.resolved":
        return t("events.public.night.resolved.count", { count: event.payload.deaths.length });
      case "game.finished":
        return t("events.public.game.finished", {
          faction: wolvesWon ? t("ui.over.packWins") : t("ui.over.villageWins"),
        });
      default:
        return null;
    }
  };
  const wolves = snapshot.players.filter((player) => player.revealedRole === "werewolf").length;
  const villagers = snapshot.players.length - wolves;
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto flex-col gap-[22px] bg-[radial-gradient(100%_45%_at_50%_0%,rgba(179,58,54,.18),transparent_70%)] px-[18px] pb-5 pt-9">
      <section className="flex flex-col items-center gap-3.5 text-center">
        <span className="h-14 w-14 rounded-full bg-blood shadow-[0_0_60px_rgba(179,58,54,.5)]" />
        <div>
          <p className="eyebrow text-blood-light">
            {t(
              `ui.over.${winner?.reason === "wolves_outnumber" ? "reasonWolvesOutnumber" : "reasonWolvesEliminated"}`,
            )}
          </p>
          <h1 className="mt-2 text-[36px] font-semibold tracking-[-0.035em]">
            {t(wolvesWon ? "ui.over.wolvesWinTitle" : "ui.over.villageWinsTitle")}
          </h1>
        </div>
        <p className="max-w-[280px] text-sm text-fog">
          {t("ui.over.summary", {
            wolves: t("ui.over.wolvesCount.count", { count: wolves }),
            villagers: t("ui.over.villagersCount.count", { count: villagers }),
            nights: t("ui.over.nightsCount.count", { count: snapshot.game.day }),
          })}
        </p>
      </section>
      <section className="flex flex-col gap-2.5">
        <p className="eyebrow">{t("ui.over.rolesRevealed")}</p>
        {snapshot.players.map((player) => {
          const wolf = player.revealedRole === "werewolf";
          return (
            <div className={`row ${wolf ? "border-blood/35 bg-blood/10" : ""}`} key={player.userId}>
              <Avatar name={player.displayName} />
              <span className="row__name text-[17px]">
                {player.displayName}
                {player.userId === snapshot.me?.userId && (
                  <span className="ml-1.5 font-mono text-[11px] text-sage-light">
                    {t("ui.you").toUpperCase()}
                  </span>
                )}
              </span>
              <span
                className={`font-mono text-xs ${wolf ? "text-blood-light" : "text-sage-light"}`}
              >
                {player.revealedRole ? t(`roles.${player.revealedRole}.name`) : ""}
              </span>
            </div>
          );
        })}
      </section>
      <section className="flex flex-col gap-2.5">
        <p className="eyebrow">{t("ui.over.replay")}</p>
        <ul className="card flex flex-col gap-2 p-2">
          {publicEvents.map((event) => (
            <li className="flex gap-3.5 px-2 py-2 text-sm text-paper-dim" key={event.id}>
              <span className="w-9 flex-none font-mono text-[11px] text-fog-dim">
                {event.kind === "phase.started" ? `D${snapshot.game.day}` : "·"}
              </span>
              {line(event)}
            </li>
          ))}
        </ul>
      </section>
      <div className="mt-auto flex gap-2.5">
        {!replay && (
          <button
            className="btn btn--ghost min-h-14 flex-1"
            onClick={() => navigate(`/games/${snapshot.game.id}/replay`)}
            type="button"
          >
            {t("ui.over.watchReplay")}
          </button>
        )}
        <button
          className="btn btn--primary min-h-14 flex-1"
          onClick={() => navigate("/create")}
          type="button"
        >
          {t("ui.over.newGame")}
        </button>
      </div>
    </div>
  );
}
