import type {
  ActionId,
  AvailableAction,
  GameEvent,
  GameplayCommand,
  PhaseId,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Avatar } from "../components.tsx";

type Send = (command: Omit<GameplayCommand, "commandId">) => Promise<void>;

type VotePick = { type: "player"; targetId: UserId } | { type: "abstain" };

type PhaseInfo = NonNullable<ViewerGameSnapshot["game"]["phase"]>;

/** Designs 07–08 · the Act tab: voting by day, night actions by night. */
export function Act({
  snapshot,
  send,
}: {
  snapshot: ViewerGameSnapshot;
  events: GameEvent[];
  send: Send;
}) {
  const phase = snapshot.game.phase;
  if (phase?.type === "voting")
    return <VotingBranch phase={phase} send={send} snapshot={snapshot} />;
  if (phase?.type === "night") return <NightBranch phase={phase} send={send} snapshot={snapshot} />;
  return null;
}

function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative flex h-6 w-6 flex-none items-center justify-center rounded-full border text-[14px] font-bold ${
        on ? "border-transparent bg-sage text-night" : "border-paper/20"
      }`}
    >
      {on ? "✓" : ""}
    </span>
  );
}

function VotingBranch({
  phase,
  snapshot,
  send,
}: {
  phase: PhaseInfo;
  snapshot: ViewerGameSnapshot;
  send: Send;
}) {
  const { t } = useTranslation();
  const progress = snapshot.progress ?? { acted: 0, eligible: 0 };
  const tallies = new Map(
    (snapshot.voteTallies ?? []).map((tally) => [tally.targetId, tally.count]),
  );
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  const me = snapshot.me;
  const alive = me?.status === "alive";
  const [picked, setPicked] = useState<{ phaseId: PhaseId; vote: VotePick } | null>(null);
  const pickedForPhase = picked !== null && picked.phaseId === phase.id ? picked.vote : null;
  const shown = pickedForPhase ?? me?.currentIntent?.vote ?? null;
  const registered = me?.currentIntent?.vote ?? null;
  const unchanged =
    shown !== null &&
    registered !== null &&
    shown.type === registered.type &&
    (shown.type === "abstain" ||
      (registered.type === "player" && shown.targetId === registered.targetId));
  const rows = snapshot.players.filter(
    (player) => player.status === "alive" || player.status === "dead",
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="screen__scroll flex flex-col gap-4 px-[18px] pb-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-2xl font-semibold tracking-[-0.025em] text-paper">
            {t("ui.vote.title")}
          </h2>
          <span
            aria-label={t("ui.votingProgress")}
            className="font-mono text-[13px] text-fog"
            role="status"
          >
            {t("ui.vote.progress", { acted: progress.acted, eligible: progress.eligible })}
          </span>
        </div>
        <ul className="flex flex-col gap-2.5">
          {rows.map((player) => {
            const isMe = player.userId === me?.userId;
            if (player.status === "alive" && isMe) return null;
            const dead = player.status === "dead";
            const count = tallies.get(player.userId) ?? 0;
            const selected = shown?.type === "player" && shown.targetId === player.userId;
            const width =
              progress.eligible > 0 ? Math.min(100, (count / progress.eligible) * 100) : 0;
            return (
              <li key={player.userId}>
                <button
                  aria-pressed={selected}
                  className={`row relative w-full overflow-hidden text-left disabled:cursor-not-allowed ${
                    dead ? "row--dead" : ""
                  }`}
                  disabled={!alive || dead || isMe}
                  onClick={() =>
                    setPicked({
                      phaseId: phase.id,
                      vote: { type: "player", targetId: player.userId },
                    })
                  }
                  style={selected ? { borderColor: "var(--color-blood)" } : undefined}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="vote-row__fill"
                    style={{ width: `${width}%` }}
                  />
                  <span className="relative flex-none">
                    <Avatar dead={dead} name={player.displayName} />
                  </span>
                  <span className="relative row__name text-[17px] font-medium">
                    {player.displayName}
                    {dead && player.revealedRole !== undefined && (
                      <span className="text-fog"> · {t(`roles.${player.revealedRole}.name`)}</span>
                    )}
                  </span>
                  <span
                    className={`relative font-mono text-[16px] ${
                      selected ? "text-blood-light" : count > 0 ? "text-fog" : "text-fog-dim"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              aria-pressed={shown?.type === "abstain"}
              className="row relative w-full text-left disabled:cursor-not-allowed"
              disabled={!alive}
              onClick={() => setPicked({ phaseId: phase.id, vote: { type: "abstain" } })}
              style={shown?.type === "abstain" ? { borderColor: "var(--color-blood)" } : undefined}
              type="button"
            >
              <span className="relative row__name text-[17px] font-medium">{t("ui.abstain")}</span>
            </button>
          </li>
        </ul>
      </div>
      {alive && shown !== null && (
        <div className="border-t border-paper/10 bg-bar px-[18px] py-3">
          <button
            className="btn btn--primary w-full"
            disabled={unchanged}
            onClick={() => {
              // The error already renders above; the catch only prevents an unhandled rejection.
              if (shown.type === "abstain") {
                void send({ type: "vote.abstain", phaseId: phase.id, payload: {} }).catch(
                  () => undefined,
                );
              } else {
                void send({
                  type: "vote.set",
                  phaseId: phase.id,
                  payload: { targetId: shown.targetId },
                }).catch(() => undefined);
              }
            }}
            type="button"
          >
            {unchanged
              ? t("ui.vote.voteLocked")
              : shown.type === "abstain"
                ? t("ui.vote.lockAbstain")
                : t("ui.vote.lockVote", { player: names.get(shown.targetId) ?? shown.targetId })}
          </button>
        </div>
      )}
    </div>
  );
}

function NightBranch({
  phase,
  snapshot,
  send,
}: {
  phase: PhaseInfo;
  snapshot: ViewerGameSnapshot;
  send: Send;
}) {
  const { t } = useTranslation();
  const me = snapshot.me;
  const role = me?.role;
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  const actions = snapshot.availableActions;
  const [picked, setPicked] = useState<{
    phaseId: PhaseId;
    active: ActionId | null;
    actions: Record<string, { targetId?: UserId }>;
  } | null>(() => {
    const server = me?.currentIntent?.actions ?? {};
    const first = Object.keys(server)[0] as ActionId | undefined;
    return { phaseId: phase.id, active: first ?? null, actions: server };
  });
  const pickedForPhase = picked !== null && picked.phaseId === phase.id ? picked : null;
  const activeAction =
    pickedForPhase !== null && pickedForPhase.active !== null
      ? actions.find((action) => action.id === pickedForPhase.active)
      : undefined;
  const activeEntry =
    pickedForPhase !== null && pickedForPhase.active !== null
      ? pickedForPhase.actions[pickedForPhase.active]
      : undefined;
  const setPick = (actionId: ActionId, entry: { targetId?: UserId } | null) => {
    setPicked((current) => {
      const base =
        current !== null && current.phaseId === phase.id
          ? current
          : { phaseId: phase.id, active: null as ActionId | null, actions: {} };
      const next = { ...base.actions };
      if (entry === null) delete next[actionId];
      else next[actionId] = entry;
      return { phaseId: phase.id, active: actionId, actions: next };
    });
  };
  const confirm = (() => {
    if (activeAction === undefined || activeEntry === undefined) return null;
    if (activeAction.type === "choice") {
      return {
        label: t(`actions.${activeAction.id}.label`),
        send: () =>
          void send({
            type: "night.action.set",
            phaseId: phase.id,
            payload: { action: activeAction.id },
          } as Omit<GameplayCommand, "commandId">).catch(() => undefined),
      };
    }
    const targetId = activeEntry.targetId;
    if (targetId === undefined) return null;
    return {
      label: names.get(targetId) ?? targetId,
      send: () =>
        void send({
          type: "night.action.set",
          phaseId: phase.id,
          payload: { action: activeAction.id, targetId },
        } as Omit<GameplayCommand, "commandId">).catch(() => undefined),
    };
  })();
  if (actions.length === 0) {
    return (
      <div className="screen__scroll flex flex-col gap-4 px-[18px] pb-5">
        {role !== undefined && (
          <p className="eyebrow">{t("ui.night.yourMove", { role: t(`roles.${role}.name`) })}</p>
        )}
        <p className="text-sm text-fog">{t("ui.night.noAction")}</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="screen__scroll flex flex-col gap-5 px-[18px] pb-5">
        {role !== undefined && (
          <p className="eyebrow">{t("ui.night.yourMove", { role: t(`roles.${role}.name`) })}</p>
        )}
        {actions.map((action) => (
          <section className="flex flex-col gap-3" key={action.id}>
            <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.03em] text-paper">
              {t(`actions.${action.id}.prompt`)}
            </h2>
            {action.type === "choice" ? (
              <ul className="flex flex-col gap-2.5">
                <li>
                  <button
                    aria-pressed={selectedChoice(pickedForPhase, action)}
                    className={`row relative w-full text-left ${
                      selectedChoice(pickedForPhase, action) ? "row--selected" : ""
                    }`}
                    onClick={() =>
                      setPick(action.id, selectedChoice(pickedForPhase, action) ? null : {})
                    }
                    type="button"
                  >
                    <span className="relative row__name text-[17px] font-medium">
                      {t(`actions.${action.id}.label`)}
                    </span>
                    <CheckMark on={selectedChoice(pickedForPhase, action)} />
                  </button>
                </li>
              </ul>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {action.targets.map((target) => {
                  const selected = pickedForPhase?.actions[action.id]?.targetId === target.userId;
                  const name = names.get(target.userId) ?? target.userId;
                  return (
                    <li key={target.userId}>
                      <button
                        aria-pressed={selected}
                        className={`row relative w-full text-left disabled:cursor-not-allowed disabled:opacity-40 ${
                          selected ? "row--selected" : ""
                        }`}
                        disabled={!target.enabled}
                        onClick={() => setPick(action.id, { targetId: target.userId })}
                        type="button"
                      >
                        <span className="relative flex-none">
                          <Avatar name={name} />
                        </span>
                        <span className="relative row__name text-[17px] font-medium">{name}</span>
                        <CheckMark on={selected} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
        <div className="flex items-center gap-2.5 rounded-[14px] border border-paper/10 bg-surface px-3.5 py-3 text-sm text-fog">
          <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-sage" />
          {t("ui.night.villageSleeps")}
        </div>
      </div>
      {confirm !== null && (
        <div className="border-t border-paper/10 bg-bar px-[18px] py-3">
          <button className="btn btn--pale w-full" onClick={confirm.send} type="button">
            {t("ui.night.confirm", { player: confirm.label })}
          </button>
        </div>
      )}
    </div>
  );
}

function selectedChoice(
  pickedForPhase: { actions: Record<string, { targetId?: UserId }> } | null,
  action: AvailableAction,
): boolean {
  return pickedForPhase !== null && action.id in pickedForPhase.actions;
}
