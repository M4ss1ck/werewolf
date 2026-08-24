import type { GameSummary } from "@werewolf/protocol";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { Avatar, AvatarStack, Chip, Countdown, ErrorMessage } from "../components.tsx";
import { navigate } from "../routes.tsx";

type Filter = "all" | "lobby" | "running";

const FILTERS: { id: Filter; labelKey: "filterAll" | "filterLobby" | "filterRunning" }[] = [
  { id: "all", labelKey: "filterAll" },
  { id: "lobby", labelKey: "filterLobby" },
  { id: "running", labelKey: "filterRunning" },
];

function secondaryLine(game: GameSummary, t: TFunction) {
  const count = t("ui.players.count", { count: game.playerCount });
  if (game.status === "running" && game.phase !== undefined)
    return `${count} · ${t("ui.browser.dayPhase", {
      day: game.day,
      phase: t(`phases.${game.phase.type}`),
    })}`;
  if (game.scheduledAt !== undefined)
    return (
      <>
        {count} ·{" "}
        {t("ui.browser.startsIn", {
          time: <Countdown endsAt={game.scheduledAt} serverNow={game.serverNow} />,
        })}
      </>
    );
  return count;
}

function GameCard({ game }: { game: GameSummary }) {
  const { t } = useTranslation();
  if (game.status === "finished") {
    return (
      <button
        className="card flex flex-col gap-1.5 text-left"
        onClick={() => navigate(`/games/${game.id}/replay`)}
        type="button"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[19px] font-semibold tracking-[-0.02em] text-fog">
            {game.name}
          </span>
          {game.visibility === "private" && (
            <span className="shrink-0">
              <Chip>{t("ui.visibilityPrivate")}</Chip>
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-fog-dim">
          {t("ui.browser.finished")} · {t("ui.players.count", { count: game.playerCount })}
        </span>
      </button>
    );
  }
  const lobby = game.status === "lobby" || game.status === "scheduled";
  return (
    <article className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[21px] font-semibold tracking-[-0.02em]">{game.name}</h3>
          <p className="mt-1.5 font-mono text-xs text-fog">{secondaryLine(game, t)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {game.visibility === "private" && <Chip>{t("ui.visibilityPrivate")}</Chip>}
          <Chip tone={lobby ? "lobby" : "running"}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            {t(`gameStatuses.${game.status}`)}
          </Chip>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <AvatarStack names={game.players.map((player) => player.displayName)} />
        <button
          className={`btn ${lobby ? "btn--primary" : "btn--ghost"}`}
          onClick={() => navigate(`/games/${game.id}`)}
          type="button"
        >
          {lobby ? t("ui.join") : t("ui.spectate")}
        </button>
      </div>
    </article>
  );
}

/** Design 03 · the public game browser. */
export function GamesScreen({ username }: { username: string }) {
  const { t } = useTranslation();
  const [games, setGames] = useState<GameSummary[]>([]);
  const [error, setError] = useState<unknown>();
  const [filter, setFilter] = useState<Filter>("lobby");
  useEffect(() => {
    void api.listGames().then(setGames).catch(setError);
  }, []);
  const visible = games.filter((game) =>
    filter === "all"
      ? true
      : filter === "lobby"
        ? (game.status === "lobby" || game.status === "scheduled") && game.visibility !== "private"
        : game.status === "running" && game.visibility !== "private",
  );
  return (
    <div className="screen__scroll flex flex-col gap-5 px-4.5 pb-5 pt-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-[30px] font-semibold tracking-[-0.03em]">{t("ui.openGames")}</h1>
        <button
          aria-label={t("ui.tabs.profile")}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-paper/20 bg-paper/5"
          onClick={() => navigate("/profile")}
          type="button"
        >
          <span aria-hidden="true">
            <Avatar name={username} size="md" />
          </span>
        </button>
      </header>
      <div className="flex gap-2">
        {FILTERS.map((option) => (
          <button
            aria-pressed={filter === option.id}
            className={`chip${filter === option.id ? " chip--active" : ""}`}
            key={option.id}
            onClick={() => setFilter(option.id)}
            type="button"
          >
            {t(`ui.browser.${option.labelKey}`)}
          </button>
        ))}
      </div>
      <ErrorMessage error={error} />
      {visible.length === 0 ? (
        <p className="card text-fog">{t("ui.noOpenGames")}</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {visible.map((game) => (
            <GameCard game={game} key={game.id} />
          ))}
        </div>
      )}
    </div>
  );
}
