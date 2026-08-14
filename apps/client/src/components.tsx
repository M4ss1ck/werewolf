import type { GameEvent, ViewerGameSnapshot } from "@werewolf/protocol";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { ApiError } from "./api/client.ts";

export function LanguageSwitcher({ onChange }: { onChange: (locale: "en" | "es") => void }) {
  const { i18n } = useTranslation();
  return (
    <div className="flex gap-1">
      {(["en", "es"] as const).map((language) => (
        <button
          className={`rounded border px-2 py-1 text-xs ${i18n.language === language ? "bg-slate-200" : ""}`}
          key={language}
          onClick={() => onChange(language)}
          type="button"
        >
          {language.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const code = (error as Partial<ApiError>).code ?? "UNKNOWN_ERROR";
  return (
    <p className="rounded bg-red-50 p-3 text-sm text-red-800">
      {t(`errors.${code}`, { defaultValue: t("errors.UNKNOWN_ERROR") })}
    </p>
  );
}

export function PlayerList({ snapshot }: { snapshot: ViewerGameSnapshot }) {
  const { t } = useTranslation();
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">
        {t("ui.players.count", { count: snapshot.players.length })}
      </h2>
      <ul className="space-y-2">
        {snapshot.players.map((player) => (
          <li className="flex items-center justify-between rounded border p-2" key={player.userId}>
            <span>{player.displayName}</span>
            <span className="text-sm opacity-70">
              {t(`playerStatuses.${player.status}`)}
              {player.revealedRole ? ` · ${t(`roles.${player.revealedRole}.name`)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PhaseBanner({ snapshot }: { snapshot: ViewerGameSnapshot }) {
  const { t } = useTranslation();
  const phase = snapshot.game.phase;
  if (!phase)
    return <div className="rounded border p-3">{t(`gameStatuses.${snapshot.game.status}`)}</div>;
  const seconds = Math.max(0, Math.ceil((phase.endsAt - snapshot.serverNow) / 1000));
  return (
    <section className="rounded bg-slate-900 p-4 text-white">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{t(`phases.${phase.type}`)}</h2>
        <span>{t("ui.timeRemaining", { count: seconds })}</span>
      </div>
      <p className="text-sm opacity-80">{snapshot.game.day}</p>
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
    <section>
      <h2 className="mb-2 text-lg font-semibold">{t("ui.yourRole")}</h2>
      <ul className="space-y-1">
        {privateEvents.map((event) => (
          <li key={event.id}>{eventText(event, snapshot, t) as string}</li>
        ))}
      </ul>
    </section>
  );
}
