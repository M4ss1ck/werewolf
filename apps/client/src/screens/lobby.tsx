import { MIN_PLAYERS, type ViewerGameSnapshot } from "@werewolf/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { Avatar, ErrorMessage, Meter } from "../components.tsx";
import { navigate } from "../routes.tsx";

/** Design 05 · the game lobby: waiting card, roster, empty seats, start bar. */
export function LobbyScreen({
  snapshot,
  onUpdate,
}: {
  snapshot: ViewerGameSnapshot;
  onUpdate: (next: ViewerGameSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>();
  const isOwner = snapshot.game.ownerUserId === snapshot.me?.userId;
  const ready = snapshot.players.length >= MIN_PLAYERS;
  const emptySeats = Math.max(0, MIN_PLAYERS - snapshot.players.length);
  const emptySeatNumbers = Array.from(
    { length: emptySeats },
    (_, index) => snapshot.players.length + index + 1,
  );
  const act = async (operation: () => Promise<ViewerGameSnapshot>) => {
    try {
      onUpdate(await operation());
    } catch (caught) {
      setError(caught);
    }
  };
  // The owner's cancel feeds the snapshot back so the shell lands on the
  // cancelled screen; a guest just leaves and heads home to the list.
  const leave = async () => {
    try {
      await api.leave(snapshot.game.id);
      navigate("/");
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="screen__scroll flex flex-col gap-5 px-[18px] pb-5 pt-6">
        <header>
          <p className="eyebrow">
            {t("ui.lobby.label")} ·{" "}
            {snapshot.game.settings.visibility === "public"
              ? t("ui.visibilityPublic")
              : t("ui.visibilityPrivate")}
          </p>
          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.03em]">
            {snapshot.game.name}
          </h1>
        </header>
        <ErrorMessage error={error} />
        <section className="card flex flex-col gap-[14px]">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base text-paper-dim">{t("ui.lobby.waitingForPlayers")}</h2>
            <span className="font-mono text-base">
              {t("ui.lobby.seatsFilled", { count: snapshot.players.length, min: MIN_PLAYERS })}
            </span>
          </div>
          <Meter max={MIN_PLAYERS} value={snapshot.players.length} />
          {!ready && (
            <p className="text-sm text-fog">
              {t("ui.lobby.oneMoreNeeded.count", { count: MIN_PLAYERS - snapshot.players.length })}
            </p>
          )}
        </section>
        <section className="flex flex-col gap-2.5">
          <p className="eyebrow">{t("ui.lobby.inTheVillage")}</p>
          <ul className="flex flex-col gap-2.5">
            {snapshot.players.map((player) => {
              const isHost = player.userId === snapshot.game.ownerUserId;
              return (
                <li className={`row${isHost ? " row--selected" : ""}`} key={player.userId}>
                  <Avatar name={player.displayName} size="md" />
                  <span className="row__name text-[17px]">{player.displayName}</span>
                  {isHost ? (
                    <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-sage-light">
                      {t("ui.lobby.youHost")}
                    </span>
                  ) : isOwner ? (
                    <button
                      aria-label={t("ui.lobby.kickPlayer", { player: player.displayName })}
                      className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-blood/14 text-[18px] text-blood-light"
                      onClick={() => void act(() => api.kick(snapshot.game.id, player.userId))}
                      type="button"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  ) : null}
                </li>
              );
            })}
            {emptySeatNumbers.map((seat) => (
              <li
                className="flex items-center gap-[14px] rounded-[14px] border border-dashed border-paper/15 px-3.5 py-3 text-fog-dim"
                key={`empty-${seat}`}
              >
                <span
                  aria-hidden="true"
                  className="h-[42px] w-[42px] rounded-full border border-dashed border-paper/20"
                />
                <span className="text-[17px]">{t("ui.lobby.emptySeat")}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="flex gap-2.5 border-t border-paper/8 bg-bar px-[18px] py-3 pb-4">
        <button
          className="btn btn--danger"
          onClick={() => void (isOwner ? act(() => api.cancel(snapshot.game.id)) : leave())}
          type="button"
        >
          {isOwner ? t("ui.cancel") : t("ui.leave")}
        </button>
        {/* Only the host can start; the server refuses anyone else, so offering
         * the control to a guest would just be a button that always fails. */}
        {isOwner && (
          <button
            className="btn btn--primary flex-1"
            disabled={!ready}
            onClick={() => void act(() => api.start(snapshot.game.id))}
            type="button"
          >
            {ready
              ? t("ui.start")
              : t("ui.lobby.startNeeds.count", { count: MIN_PLAYERS - snapshot.players.length })}
          </button>
        )}
      </div>
    </div>
  );
}
