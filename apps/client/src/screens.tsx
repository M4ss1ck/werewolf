import type { GameEvent, GameplayCommand, ViewerGameSnapshot } from "@werewolf/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type PublicGame } from "./api/client.ts";
import { LiveGameConnection, type LiveStatus } from "./api/live.ts";
import type { Session } from "./auth/session.ts";
import {
  ErrorMessage,
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
    <section className="flex w-full max-w-md flex-col gap-4 rounded border bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold">Werewolf</h1>
      <LanguageSwitcher onChange={(language) => void changeLocale(language, Boolean(session))} />
      {session ? (
        <>
          <p>{session.user.name ?? session.user.email ?? session.user.id}</p>
          <button
            className="rounded bg-slate-900 px-4 py-2 text-white"
            onClick={() =>
              void import("./auth/session.ts").then(({ signOut }) => signOut()).then(onRefresh)
            }
            type="button"
          >
            {t("ui.signOut")}
          </button>
        </>
      ) : (
        <button
          className="rounded bg-slate-900 px-4 py-2 text-white"
          onClick={() =>
            void import("./auth/session.ts").then(({ signInWithGoogle }) => signInWithGoogle())
          }
          type="button"
        >
          {t("ui.signIn")} · Google
        </button>
      )}
    </section>
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
    <div className="w-full max-w-5xl space-y-6">
      <ErrorMessage error={error} />
      <div className="grid gap-6 md:grid-cols-[1fr_20rem]">
        <section>
          <h1 className="mb-4 text-2xl font-semibold">{t("ui.waitingForPlayers")}</h1>
          <div className="space-y-3">
            {games.map((game) => (
              <article
                className="flex flex-wrap items-center justify-between gap-3 rounded border p-4"
                key={game.id}
              >
                <div>
                  <h2 className="font-semibold">{game.name}</h2>
                  <p className="text-sm opacity-70">
                    {t("ui.players.count", { count: game.playerCount ?? 0 })} ·{" "}
                    {t(`gameStatuses.${game.status}`)}
                  </p>
                </div>
                <button
                  className="rounded border px-3 py-2"
                  onClick={() => onOpen(game.id)}
                  type="button"
                >
                  {game.status === "running" ? t("ui.spectate") : t("ui.join")}
                </button>
              </article>
            ))}
          </div>
        </section>
        <form className="space-y-3 rounded border p-4" onSubmit={(event) => void create(event)}>
          <h2 className="text-lg font-semibold">{t("ui.createGame")}</h2>
          <input
            className="w-full rounded border p-2"
            onChange={(event) => setName(event.target.value)}
            placeholder={t("ui.createGame")}
            required
            value={name}
          />
          <select
            className="w-full rounded border p-2"
            onChange={(event) => setVisibility(event.target.value as "public" | "private")}
            value={visibility}
          >
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
          <label className="flex gap-2">
            <input
              checked={spectatingEnabled}
              onChange={(event) => setSpectatingEnabled(event.target.checked)}
              type="checkbox"
            />
            {t("ui.spectate")}
          </label>
          <input
            className="w-full rounded border p-2"
            onChange={(event) => setScheduledAt(event.target.value)}
            type="datetime-local"
            value={scheduledAt}
          />
          {Object.entries(durations).map(([key, value]) => (
            <label className="block text-sm" key={key}>
              {key}
              <input
                className="ml-2 w-20 rounded border p-1"
                min="1"
                onChange={(event) =>
                  setDurations((current) => ({ ...current, [key]: Number(event.target.value) }))
                }
                type="number"
                value={value}
              />
            </label>
          ))}
          <button className="w-full rounded bg-slate-900 px-4 py-2 text-white" type="submit">
            {t("ui.createGame")}
          </button>
        </form>
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
      <h1 className="text-2xl font-semibold">{snapshot.game.name}</h1>
      <PlayerList snapshot={snapshot} />
      {snapshot.players.length < 5 && <p>{t("ui.notEnoughPlayers", { count: 5 })}</p>}
      <div className="flex flex-wrap gap-2">
        {isOwner ? (
          <>
            <button
              className="rounded bg-slate-900 px-3 py-2 text-white"
              onClick={() => void act(() => api.start(snapshot.game.id))}
              type="button"
            >
              {t("ui.start")}
            </button>
            <button
              className="rounded border px-3 py-2"
              onClick={() => void act(() => api.cancel(snapshot.game.id))}
              type="button"
            >
              {t("ui.cancel")}
            </button>
            {snapshot.players
              .filter((player) => player.userId !== snapshot.me?.userId)
              .map((player) => (
                <button
                  className="rounded border px-3 py-2"
                  key={player.userId}
                  onClick={() => void act(() => api.kick(snapshot.game.id, player.userId))}
                  type="button"
                >
                  {t("ui.cancel")} · {player.displayName}
                </button>
              ))}
          </>
        ) : (
          <button
            className="rounded border px-3 py-2"
            onClick={() => void act(() => api.leave(snapshot.game.id))}
            type="button"
          >
            {t("ui.leave")}
          </button>
        )}
      </div>
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
  if (snapshot.availableActions.length === 0 || phaseId === undefined) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t("ui.vote")}</h2>
      {snapshot.availableActions.map((action) => (
        <div key={action.id}>
          <h3 className="font-medium">{t(`actions.${action.id}.label`)}</h3>
          {action.type === "choice" ? (
            <button
              className="rounded border px-3 py-2"
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
                  className="rounded border px-3 py-2 disabled:opacity-40"
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
                  {target.userId}
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
    <section className="space-y-3">
      <div className="flex gap-2">
        <button
          className="rounded border px-2 py-1"
          onClick={() => setChannel("public")}
          type="button"
        >
          {t("ui.publicChat")}
        </button>
        {snapshot.availableChannels.includes("wolves") && (
          <button
            className="rounded border px-2 py-1"
            onClick={() => setChannel("wolves")}
            type="button"
          >
            {t("ui.wolfChat")}
          </button>
        )}
      </div>
      <ul className="min-h-16 space-y-1 rounded border p-3">
        {messages.map(
          (event) => event.kind === "chat.message" && <li key={event.id}>{event.payload.text}</li>,
        )}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || !snapshot.game.phase) return;
          send({ type: "chat.send", phaseId: snapshot.game.phase.id, payload: { channel, text } });
          setText("");
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border p-2"
          disabled={readOnly}
          onChange={(event) => setText(event.target.value)}
          value={text}
        />
        <button
          className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-40"
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
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{snapshot.game.name}</h1>
        {status === "reconnecting" && <span className="text-sm opacity-70">{status}</span>}
      </div>
      <PhaseBanner snapshot={snapshot} />
      {isVoting && snapshot.progress && snapshot.game.phase && (
        <section className="space-y-2">
          <p>
            {snapshot.progress.acted} / {snapshot.progress.eligible}
          </p>
          <div className="flex flex-wrap gap-2">
            {snapshot.players
              .filter(
                (player) => player.status === "alive" && player.userId !== snapshot.me?.userId,
              )
              .map((player) => (
                <button
                  className="rounded border px-3 py-2"
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
              className="rounded border px-3 py-2"
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
      <div className="grid gap-6 md:grid-cols-2">
        <PlayerList snapshot={snapshot} />
        <section className="space-y-5">
          {snapshot.me?.role && (
            <div className="rounded border p-4">
              <h2 className="font-semibold">{t("ui.yourRole")}</h2>
              <p>{t(`roles.${snapshot.me.role}.name`)}</p>
            </div>
          )}
          <ActionControls send={send} snapshot={snapshot} />
          <PrivateFeed events={events} snapshot={snapshot} />
        </section>
      </div>
      <Chat events={events} send={send} snapshot={snapshot} />
      {replay && (
        <section>
          <h2 className="text-lg font-semibold">{t("ui.replay")}</h2>
          {events.map((event) => (
            <p key={event.id}>{event.kind}</p>
          ))}
        </section>
      )}
    </div>
  );
}
