import type { GameEvent, GamePhase, ViewerGameSnapshot } from "@werewolf/protocol";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { ApiError } from "./api/client.ts";

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "·";
}

export function LanguageSwitcher({ onChange }: { onChange: (locale: "en" | "es") => void }) {
  const { i18n, t } = useTranslation();
  return (
    <fieldset className="m-0 flex gap-1 border-0 p-0">
      <legend className="sr-only">{t("ui.language")}</legend>
      {(["en", "es"] as const).map((language) => (
        <button
          aria-pressed={i18n.language === language}
          className={`btn btn--sm ${i18n.language === language ? "btn--active" : "btn--quiet"}`}
          key={language}
          onClick={() => onChange(language)}
          type="button"
        >
          {language.toUpperCase()}
        </button>
      ))}
    </fieldset>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const code = (error as Partial<ApiError>).code ?? "UNKNOWN_ERROR";
  return (
    <p
      className="rounded-md border border-omen/50 bg-omen/15 px-3 py-2 text-sm text-paper"
      role="alert"
    >
      {t(`errors.${code}`, { defaultValue: t("errors.UNKNOWN_ERROR") })}
    </p>
  );
}

export function PlayerList({ snapshot }: { snapshot: ViewerGameSnapshot }) {
  const { t } = useTranslation();
  const me = snapshot.me?.userId;
  return (
    <section>
      <h2 className="mb-2 font-display text-lg text-paper">
        {t("ui.players.count", { count: snapshot.players.length })}
      </h2>
      <ul className="space-y-2">
        {snapshot.players.map((player) => {
          const isMe = player.userId === me;
          return (
            <li className={`player-row ${isMe ? "player-row--me" : ""}`} key={player.userId}>
              <span aria-hidden="true" className="avatar">
                {initialsOf(player.displayName)}
              </span>
              <span className="player-row__name">
                <span>{player.displayName}</span>
                {isMe && (
                  <span className="ml-2 rounded-full bg-gold/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-gold">
                    {t("ui.you")}
                  </span>
                )}
              </span>
              <span className="status-chip" data-status={player.status}>
                {t(`playerStatuses.${player.status}`)}
                {player.revealedRole ? ` · ${t(`roles.${player.revealedRole}.name`)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Moon({ phase }: { phase: GamePhase | null }) {
  const state = phase ? `moon--${phase}` : "moon--full";
  return (
    <div aria-hidden="true" className={`moon ${state}`}>
      <span className="moon__shade" />
    </div>
  );
}

function PhaseRail({ current }: { current: GamePhase }) {
  const { t } = useTranslation();
  const phases: GamePhase[] = ["discussion", "voting", "night"];
  const activeIndex = phases.indexOf(current);
  return (
    <ol aria-label={t("ui.phaseRail")} className="phase-rail">
      {phases.map((phase, index) => (
        <li
          aria-current={index === activeIndex ? "step" : undefined}
          className={`phase-rail__step ${index === activeIndex ? "is-active" : ""} ${
            index < activeIndex ? "is-past" : ""
          }`}
          key={phase}
        >
          <span aria-hidden="true" className="phase-rail__dot" />
          <span className="phase-rail__label">{t(`phases.${phase}`)}</span>
        </li>
      ))}
    </ol>
  );
}

export function PhaseBanner({ snapshot }: { snapshot: ViewerGameSnapshot }) {
  const { t } = useTranslation();
  const phase = snapshot.game.phase;
  const seconds = phase ? Math.max(0, Math.ceil((phase.endsAt - snapshot.serverNow) / 1000)) : 0;
  return (
    <section className="flex flex-col items-center gap-5 rounded-lg border border-fog/15 bg-night/30 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-5">
      <Moon phase={phase?.type ?? null} />
      <div className="w-full min-w-0 flex-1">
        {phase ? (
          <>
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-fog">
                {t("ui.day", { count: snapshot.game.day })}
              </span>
              <span className="font-mono text-sm text-gold">
                {t("ui.timeRemaining", { count: seconds })}
              </span>
            </p>
            <PhaseRail current={phase.type} />
          </>
        ) : (
          <p className="text-center font-display text-lg text-gold sm:text-left">
            {t(`gameStatuses.${snapshot.game.status}`)}
          </p>
        )}
      </div>
    </section>
  );
}

function eventText(event: GameEvent, snapshot: ViewerGameSnapshot, t: TFunction) {
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  switch (event.kind) {
    case "role.assigned":
      return t("events.player.role.assigned", { role: t(`roles.${event.payload.role}.name`) });
    case "seer.result":
      return t("events.player.seer.result", {
        player: names.get(event.payload.targetId) ?? event.payload.targetId,
        role: t(`roles.${event.payload.role}.name`),
      });
    case "cursed.converted":
      return t("events.player.cursed.converted", { role: t(`roles.${event.payload.role}.name`) });
    case "harlot.result":
      return t(`events.player.harlot.result.${event.payload.outcome}`);
    default:
      return null;
  }
}

export function PrivateFeed({
  events,
  snapshot,
}: {
  events: GameEvent[];
  snapshot: ViewerGameSnapshot;
}) {
  const { t } = useTranslation();
  const privateEvents = events.filter((event) =>
    ["role.assigned", "seer.result", "cursed.converted", "harlot.result"].includes(event.kind),
  );
  if (privateEvents.length === 0) return null;
  return (
    <section className="panel">
      <h2 className="font-display text-lg text-gold">{t("ui.yourIntel")}</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-paper">
        {privateEvents.map((event) => (
          <li key={event.id}>{eventText(event, snapshot, t) as string}</li>
        ))}
      </ul>
    </section>
  );
}
