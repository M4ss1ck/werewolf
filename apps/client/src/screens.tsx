import type { GameEvent, GameplayCommand, ViewerGameSnapshot } from "@werewolf/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type PublicGame } from "./api/client.ts";
import { LiveGameConnection, type LiveStatus } from "./api/live.ts";
import type { Session } from "./auth/session.ts";
import {
  ErrorMessage,
  initialsOf,
  LanguageSwitcher,
  PhaseBanner,
  PlayerList,
  PrivateFeed,
} from "./components.tsx";
import { changeLocale } from "./i18n/i18n.ts";

export function SignInScreen({
  session,
  onRefresh,
}: {
  session: Session | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      <LanguageSwitcher onChange={(language) => void changeLocale(language, Boolean(session))} />
      {session ? (
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="avatar">
            {initialsOf(session.user.name ?? session.user.email ?? session.user.id)}
          </span>
          <span className="hidden max-w-40 truncate text-sm text-fog sm:inline">
            {session.user.name ?? session.user.email ?? session.user.id}
          </span>
          <button
            className="btn btn--quiet btn--sm"
            onClick={() =>
              void import("./auth/session.ts").then(({ signOut }) => signOut()).then(onRefresh)
            }
            type="button"
          >
            {t("ui.signOut")}
          </button>
        </div>
      ) : (
        <button
          className="btn btn--primary btn--sm"
          onClick={() =>
            void import("./auth/session.ts").then(({ signInWithGoogle }) => signInWithGoogle())
          }
          type="button"
        >
          {t("ui.signIn")} · Google
        </button>
      )}
    </div>
  );
}

function GameCard({ game, onOpen }: { game: PublicGame; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const running = game.status === "running";
  return (
    <article className="panel flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate font-display text-lg text-paper">{game.name}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fog">
          <span className="status-chip" data-status={game.status}>
            {t(`gameStatuses.${game.status}`)}
          </span>
          <span>{t("ui.players.count", { count: game.playerCount ?? 0 })}</span>
        </p>
      </div>
      <button
        className={running ? "btn btn--quiet" : "btn btn--primary"}
        onClick={() => onOpen(game.id)}
        type="button"
      >
        {running ? t("ui.spectate") : t("ui.join")}
      </button>
    </article>
  );
}

export function GamesScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [games, setGames] = useState<PublicGame[]>([]);
  const [error, setError] = useState<unknown>();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [spectatingEnabled, setSpectatingEnabled] = useState(true);
  const [scheduledAt, setScheduledAt] = useState("");
  const [durations, setDurations] = useState({ discussion: 120, voting: 60, night: 60 });
  useEffect(() => {
    void api.listGames().then(setGames).catch(setError);
  }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const game = await api.createGame({
        name,
        visibility,
        ...(scheduledAt ? { scheduledAt: Date.parse(scheduledAt) } : {}),
        settings: { ...durations, spectatingEnabled },
      });
      setGames((current) => [...current, game]);
      setName("");
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="w-full space-y-8">
      <ErrorMessage error={error} />
      <section className="max-w-2xl">
        <p className="font-display text-lg leading-relaxed text-fog sm:text-xl">
          {t("ui.homeTagline")}
        </p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <section className="min-w-0">
          <h2 className="mb-3 font-display text-xl text-paper sm:text-2xl">{t("ui.openGames")}</h2>
          {games.length === 0 ? (
            <p className="panel text-fog">{t("ui.noOpenGames")}</p>
          ) : (
            <ul className="space-y-3">
              {games.map((game) => (
                <li key={game.id}>
                  <GameCard game={game} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside className="min-w-0">
          <form className="panel space-y-4" onSubmit={(event) => void create(event)}>
            <h2 className="font-display text-xl text-gold">{t("ui.createGame")}</h2>
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="create-name">
                {t("ui.gameName")}
              </label>
              <input
                className="field-input w-full"
                id="create-name"
                onChange={(event) => setName(event.target.value)}
                placeholder={t("ui.gameNamePlaceholder")}
                required
                value={name}
              />
            </div>
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="create-visibility">
                {t("ui.visibility")}
              </label>
              <select
                className="field-input w-full"
                id="create-visibility"
                onChange={(event) => setVisibility(event.target.value as "public" | "private")}
                value={visibility}
              >
                <option value="public">{t("ui.visibilityPublic")}</option>
                <option value="private">{t("ui.visibilityPrivate")}</option>
              </select>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-paper">
              <input
                checked={spectatingEnabled}
                className="accent-gold"
                onChange={(event) => setSpectatingEnabled(event.target.checked)}
                type="checkbox"
              />
              {t("ui.allowSpectating")}
            </label>
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="create-scheduled">
                {t("ui.scheduledStart")}
              </label>
              <input
                className="field-input w-full"
                id="create-scheduled"
                onChange={(event) => setScheduledAt(event.target.value)}
                type="datetime-local"
                value={scheduledAt}
              />
            </div>
            <fieldset className="space-y-2.5">
              <legend className="field-label">{t("ui.phaseDurations")}</legend>
              {Object.entries(durations).map(([key, value]) => (
                <div className="flex items-center gap-2" key={key}>
                  <label className="min-w-0 flex-1 text-sm text-paper" htmlFor={`duration-${key}`}>
                    {t(`phases.${key}`)}
                  </label>
                  <input
                    className="field-input w-24 flex-none"
                    id={`duration-${key}`}
                    min="1"
                    onChange={(event) =>
                      setDurations((current) => ({ ...current, [key]: Number(event.target.value) }))
                    }
                    type="number"
                    value={value}
                  />
                  <span className="w-16 flex-none text-xs text-fog">{t("ui.seconds")}</span>
                </div>
              ))}
            </fieldset>
            <button className="btn btn--primary w-full" type="submit">
              {t("ui.createGame")}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

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
  const ready = snapshot.players.length >= 5;
  const act = async (operation: () => Promise<ViewerGameSnapshot>) => {
    try {
      onUpdate(await operation());
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="w-full max-w-3xl space-y-5">
      <ErrorMessage error={error} />
      <header className="panel space-y-2">
        <h1 className="font-display text-2xl text-paper sm:text-3xl">{snapshot.game.name}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="status-chip" data-status={snapshot.game.status}>
            {t(`gameStatuses.${snapshot.game.status}`)}
          </span>
          {ready ? (
            <span className="chip chip--gold">{t("ui.readyToStart")}</span>
          ) : (
            <span className="chip">{t("ui.waitingForPlayers")}</span>
          )}
        </p>
      </header>
      <PlayerList snapshot={snapshot} />
      {!ready && <p className="text-sm text-fog">{t("ui.notEnoughPlayers", { count: 5 })}</p>}
      {isOwner ? (
        <div className="space-y-3">
          <button
            className="btn btn--primary"
            onClick={() => void act(() => api.start(snapshot.game.id))}
            type="button"
          >
            {t("ui.start")}
          </button>
          <div className="space-y-2 border-t border-fog/15 pt-3">
            <button
              className="btn btn--danger"
              onClick={() => void act(() => api.cancel(snapshot.game.id))}
              type="button"
            >
              {t("ui.cancel")}
            </button>
            {snapshot.players
              .filter((player) => player.userId !== snapshot.me?.userId)
              .map((player) => (
                <button
                  className="btn btn--danger"
                  key={player.userId}
                  onClick={() => void act(() => api.kick(snapshot.game.id, player.userId))}
                  type="button"
                >
                  {t("ui.cancel")} · {player.displayName}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <button
          className="btn btn--danger"
          onClick={() => void act(() => api.leave(snapshot.game.id))}
          type="button"
        >
          {t("ui.leave")}
        </button>
      )}
    </div>
  );
}

function ActionControls({
  snapshot,
  send,
}: {
  snapshot: ViewerGameSnapshot;
  send: (command: Omit<GameplayCommand, "commandId">) => void;
}) {
  const { t } = useTranslation();
  const phaseId = snapshot.game.phase?.id;
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  if (snapshot.availableActions.length === 0 || phaseId === undefined) return null;
  return (
    <section className="panel space-y-4">
      <h2 className="font-display text-lg text-gold">{t("ui.yourMove")}</h2>
      {snapshot.availableActions.map((action) => (
        <div className="space-y-2" key={action.id}>
          <h3 className="text-sm font-medium text-paper">{t(`actions.${action.id}.label`)}</h3>
          <p className="text-sm text-fog">{t(`actions.${action.id}.prompt`)}</p>
          {action.type === "choice" ? (
            <button
              className="btn btn--primary"
              onClick={() =>
                send({ type: "night.action.set", phaseId, payload: { action: action.id } } as Omit<
                  GameplayCommand,
                  "commandId"
                >)
              }
              type="button"
            >
              {t(`actions.${action.id}.label`)}
            </button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {action.targets.map((target) => (
                <button
                  className="btn btn--quiet disabled:opacity-40 disabled:hover:border-fog/30 disabled:hover:text-paper"
                  disabled={!target.enabled}
                  key={target.userId}
                  onClick={() =>
                    send({
                      type: "night.action.set",
                      phaseId,
                      payload: { action: action.id, targetId: target.userId },
                    } as Omit<GameplayCommand, "commandId">)
                  }
                  type="button"
                >
                  {names.get(target.userId) ?? target.userId}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function Chat({
  snapshot,
  events,
  send,
}: {
  snapshot: ViewerGameSnapshot;
  events: GameEvent[];
  send: (command: Omit<GameplayCommand, "commandId">) => void;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<"public" | "wolves">("public");
  const [text, setText] = useState("");
  const readOnly =
    snapshot.me?.status === "dead" ||
    (channel === "public" && snapshot.game.phase?.type === "night");
  const messages = events.filter(
    (event) => event.kind === "chat.message" && event.payload.channel === channel,
  );
  return (
    <section className="panel">
      <div className="flex gap-1 border-b border-fog/15">
        <button
          aria-pressed={channel === "public"}
          className={`chat-tab ${channel === "public" ? "chat-tab--active" : ""}`}
          onClick={() => setChannel("public")}
          type="button"
        >
          {t("ui.publicChat")}
        </button>
        {snapshot.availableChannels.includes("wolves") && (
          <button
            aria-pressed={channel === "wolves"}
            className={`chat-tab ${channel === "wolves" ? "chat-tab--active" : ""}`}
            onClick={() => setChannel("wolves")}
            type="button"
          >
            {t("ui.wolfChat")}
          </button>
        )}
      </div>
      <ul className="chat-surface">
        {messages.length === 0 ? (
          <li className="text-fog">{t("ui.chatEmpty")}</li>
        ) : (
          messages.map(
            (event) =>
              event.kind === "chat.message" && <li key={event.id}>{event.payload.text}</li>,
          )
        )}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || !snapshot.game.phase) return;
          send({ type: "chat.send", phaseId: snapshot.game.phase.id, payload: { channel, text } });
          setText("");
        }}
      >
        <label className="sr-only" htmlFor="chat-message">
          {t("ui.messageLabel")}
        </label>
        <input
          className="field-input min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={readOnly}
          id="chat-message"
          onChange={(event) => setText(event.target.value)}
          placeholder={t("ui.messagePlaceholder")}
          value={text}
        />
        <button
          className="btn btn--primary disabled:cursor-not-allowed disabled:opacity-50"
          disabled={readOnly}
          type="submit"
        >
          {t("ui.sendMessage")}
        </button>
      </form>
    </section>
  );
}

export function GameScreen({
  initial,
  replay = false,
}: {
  initial: ViewerGameSnapshot;
  replay?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connected");
  useEffect(() => {
    if (replay) {
      void api.getReplay(initial.game.id).then((result) => {
        setSnapshot(result.state);
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
  const send = (command: Omit<GameplayCommand, "commandId">) => {
    void api.postCommand(snapshot.game.id, command).catch(() => undefined);
  };
  const isVoting = snapshot.game.phase?.type === "voting";
  const spectating = snapshot.me?.status === "spectator";
  const { t } = useTranslation();
  return (
    <div className="w-full space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="truncate font-display text-2xl text-paper sm:text-3xl">
            {snapshot.game.name}
          </h1>
          {spectating && <p className="mt-1 text-sm text-fog">{t("ui.spectating")}</p>}
        </div>
        {status === "reconnecting" && (
          <span className="chip chip--gold">{t("ui.reconnecting")}</span>
        )}
      </header>
      <PhaseBanner snapshot={snapshot} />
      {isVoting && snapshot.progress && snapshot.game.phase && (
        <section className="panel space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg text-gold">{t("ui.vote")}</h2>
            <p
              aria-label={t("ui.votingProgress")}
              className="font-mono text-sm text-fog"
              role="status"
            >
              {snapshot.progress.acted} / {snapshot.progress.eligible}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {snapshot.players
              .filter(
                (player) => player.status === "alive" && player.userId !== snapshot.me?.userId,
              )
              .map((player) => (
                <button
                  className="btn btn--quiet"
                  key={player.userId}
                  onClick={() =>
                    send({
                      type: "vote.set",
                      phaseId: snapshot.game.phase!.id,
                      payload: { targetId: player.userId },
                    })
                  }
                  type="button"
                >
                  {player.displayName}
                </button>
              ))}
            <button
              className="btn btn--quiet"
              onClick={() =>
                send({ type: "vote.abstain", phaseId: snapshot.game.phase!.id, payload: {} })
              }
              type="button"
            >
              {t("ui.abstain")}
            </button>
          </div>
        </section>
      )}
      <ActionControls send={send} snapshot={snapshot} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PlayerList snapshot={snapshot} />
        <section className="min-w-0 space-y-5">
          {snapshot.me?.role && (
            <div className="panel">
              <h2 className="font-display text-lg text-gold">{t("ui.yourRole")}</h2>
              <p className="mt-1 text-paper">{t(`roles.${snapshot.me.role}.name`)}</p>
              <p className="mt-1 text-sm text-fog">{t(`roles.${snapshot.me.role}.description`)}</p>
            </div>
          )}
          <PrivateFeed events={events} snapshot={snapshot} />
        </section>
      </div>
      <Chat events={events} send={send} snapshot={snapshot} />
      {replay && (
        <section className="panel">
          <h2 className="font-display text-lg text-gold">{t("ui.replay")}</h2>
          <ul className="mt-2 space-y-1 font-mono text-xs text-fog">
            {events.map((event) => (
              <li key={event.id}>{event.kind}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
