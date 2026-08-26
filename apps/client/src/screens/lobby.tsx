import {
  type BotRosterEntry,
  type EventId,
  MIN_PLAYERS,
  type ViewerGameSnapshot,
} from "@werewolf/protocol";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../api/client.ts";
import { LiveGameConnection } from "../api/live.ts";
import { invitationUrl } from "../api/origin.ts";
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
  const [bots, setBots] = useState<BotRosterEntry[]>([]);
  // Seating a bot is a slow round trip in production, so the seat is shown as
  // taken the moment it is clicked and the server's snapshot reconciles it.
  const [seatingBotIds, setSeatingBotIds] = useState<string[]>([]);
  const [invitation, setInvitation] = useState<{ code: string }>();
  const [copyState, setCopyState] = useState<"copied" | undefined>();
  const isOwner = snapshot.game.ownerUserId === snapshot.me?.userId;
  useEffect(() => {
    if (!isOwner) return;
    void api
      .getInvitation(snapshot.game.id)
      .then(setInvitation)
      .catch(() => setInvitation(undefined));
  }, [isOwner, snapshot.game.id]);
  // The socket can deliver the seated bot before the request that seated it
  // resolves, so drop a pending seat whose bot is already at the table rather
  // than showing it twice. Roster names are unique, and the projection carries
  // no bot id to match on.
  const seatedBotNames = new Set(
    snapshot.players.filter((player) => player.isBot).map((player) => player.displayName),
  );
  const seatingBots = bots.filter(
    (bot) => seatingBotIds.includes(bot.id) && !seatedBotNames.has(bot.displayName),
  );
  const seatCount = snapshot.players.length + seatingBots.length;
  const ready = seatCount >= MIN_PLAYERS;
  const emptySeats = Math.max(0, MIN_PLAYERS - seatCount);
  const emptySeatNumbers = Array.from({ length: emptySeats }, (_, index) => seatCount + index + 1);
  // Only the host may list bots, and a failed load just means no roster: the
  // lobby still works, it simply offers nobody to add.
  const loadBots = useCallback(() => {
    if (!isOwner) return;
    void api
      .listBots(snapshot.game.id)
      .then(setBots)
      .catch(() => setBots([]));
  }, [isOwner, snapshot.game.id]);
  useEffect(loadBots, [loadBots]);
  // A lobby has no event history the screen needs, so subscribe from cursor 0:
  // the sync frame's snapshot is the whole update. Without this socket a
  // scheduled start — or the host starting the game — never reaches a waiting
  // guest; the snapshot flips to running and the shell swaps screens.
  useEffect(() => {
    const connection = new LiveGameConnection(snapshot.game.id, 0 as EventId, {
      onSnapshot: onUpdate,
    });
    connection.connect();
    return () => connection.close();
  }, [snapshot.game.id, onUpdate]);
  // Every lobby action can change who is at the table — seating a bot, but
  // equally removing one — and availability is computed from that. Re-read the
  // roster after any of them rather than trying to infer it here.
  const act = async (operation: () => Promise<ViewerGameSnapshot>) => {
    try {
      onUpdate(await operation());
      loadBots();
    } catch (caught) {
      setError(caught);
    }
  };
  // A failed seating clears the optimistic seat along with the pending mark,
  // because `act` turns the rejection into a message rather than a throw.
  const seatBot = async (bot: BotRosterEntry) => {
    setSeatingBotIds((current) => [...current, bot.id]);
    await act(() => api.addBot(snapshot.game.id, bot.id));
    setSeatingBotIds((current) => current.filter((id) => id !== bot.id));
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
  const copyInvitation = async () => {
    if (!invitation) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(invitationUrl(invitation.code));
      setCopyState("copied");
    } catch {
      setError(new ApiError("INVITATION_COPY_FAILED"));
      setCopyState(undefined);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="screen__scroll flex flex-col gap-5 px-4.5 pb-5 pt-6">
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
        {isOwner && invitation && (
          <section className="card flex flex-col gap-3" aria-label={t("ui.share.title")}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="eyebrow">{t("ui.share.title")}</p>
                <p className="mt-1 font-mono text-xl tracking-[0.08em] text-bone">
                  {`${invitation.code.slice(0, 4)}-${invitation.code.slice(4, 8)}-${invitation.code.slice(8)}`}
                </p>
              </div>
              <button
                className="btn btn--ghost"
                onClick={() => void copyInvitation()}
                type="button"
              >
                {copyState === "copied" ? t("ui.share.copied") : t("ui.share.copy")}
              </button>
            </div>
          </section>
        )}
        <section className="card flex flex-col gap-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base text-paper-dim">{t("ui.lobby.waitingForPlayers")}</h2>
            <span className="font-mono text-base">
              {t("ui.lobby.seatsFilled", { count: seatCount, min: MIN_PLAYERS })}
            </span>
          </div>
          <Meter max={MIN_PLAYERS} value={seatCount} />
          {!ready && (
            <p className="text-sm text-fog">
              {t("ui.lobby.oneMoreNeeded.count", { count: MIN_PLAYERS - seatCount })}
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
                  {/* A bot seat is marked but still removable: the host added
                   * it, so the host must be able to take it back out. */}
                  {player.isBot && !isHost && (
                    <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fog">
                      {t("ui.lobby.botTag")}
                    </span>
                  )}
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
            {seatingBots.map((bot) => (
              <li className="row opacity-50" key={`seating-${bot.id}`}>
                <Avatar name={bot.displayName} size="md" />
                <span className="row__name text-[17px]">{bot.displayName}</span>
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fog">
                  {t("ui.lobby.botTag")}
                </span>
              </li>
            ))}
            {emptySeatNumbers.map((seat) => (
              <li
                className="flex items-center gap-3.5 rounded-[14px] border border-dashed border-paper/15 px-3.5 py-3 text-fog-dim"
                key={`empty-${seat}`}
              >
                <span
                  aria-hidden="true"
                  className="h-10.5 w-10.5 rounded-full border border-dashed border-paper/20"
                />
                <span className="text-[17px]">{t("ui.lobby.emptySeat")}</span>
              </li>
            ))}
          </ul>
          {isOwner && bots.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <p className="eyebrow">{t("ui.lobby.addBot")}</p>
              {bots.map((bot) => (
                <button
                  className="flex items-center gap-3.5 rounded-[14px] border border-dashed border-paper/20 px-3.5 py-3 text-left text-[17px] text-fog transition-colors enabled:hover:border-paper/40 enabled:hover:text-paper disabled:opacity-40"
                  disabled={!bot.available || seatingBotIds.includes(bot.id)}
                  key={bot.id}
                  onClick={() => void seatBot(bot)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-10.5 w-10.5 items-center justify-center rounded-full border border-dashed border-paper/20"
                  >
                    +
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{bot.displayName}</span>
                    <span className="block truncate text-[13px] text-fog-dim">
                      {bot.reason
                        ? t(`ui.lobby.botReason.${bot.reason}`)
                        : (bot.model ?? t("ui.lobby.botRandom"))}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="flex gap-2.5 border-t border-paper/8 bg-bar px-4.5 py-3 pb-4">
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
              : t("ui.lobby.startNeeds.count", { count: MIN_PLAYERS - seatCount })}
          </button>
        )}
      </div>
    </div>
  );
}
