import type { GameEvent, GameplayCommand, ViewerGameSnapshot } from "@werewolf/protocol";
import { useTranslation } from "react-i18next";

import { Avatar } from "../components.tsx";

export const INTEL_KINDS = [
  "role.assigned",
  "seer.result",
  "cursed.converted",
  "harlot.result",
] as const;

export function Me({
  snapshot,
  events,
  send,
}: {
  snapshot: ViewerGameSnapshot;
  events: GameEvent[];
  send: (command: Omit<GameplayCommand, "commandId">) => void;
}) {
  void send;
  const { t } = useTranslation();
  const role = snapshot.me?.role;
  const names = new Map(snapshot.players.map((player) => [player.userId, player.displayName]));
  const intel = events.filter((event) => (INTEL_KINDS as readonly string[]).includes(event.kind));
  const alive = snapshot.players.filter((player) => player.status === "alive").length;
  const text = (event: GameEvent) => {
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
  };
  return (
    <div className="flex flex-col gap-[22px]">
      {role !== undefined && (
        <section className="card border-sage/30 bg-gradient-to-b from-sage/15 to-sage/[0.02]">
          <p className="eyebrow text-sage-light">{t("ui.yourRole")}</p>
          <div className="mt-4 flex items-center gap-[18px]">
            <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-sage/50 bg-night">
              <span className="h-[26px] w-[26px] rounded-full bg-sage-light shadow-[0_0_22px_rgba(159,188,173,.6)]" />
            </span>
            <div>
              <h1 className="text-[36px] font-semibold tracking-[-0.035em]">
                {t(`roles.${role}.name`)}
              </h1>
              <p className="mt-1 font-mono text-xs text-sage-light">
                {t("ui.factionTeam", {
                  faction: t(
                    `factions.${snapshot.me?.faction ?? (role === "werewolf" ? "wolves" : "village")}`,
                  ),
                })}
              </p>
            </div>
          </div>
          <p className="mt-4 text-base leading-relaxed text-paper-dim">
            {t(`roles.${role}.description`)}
          </p>
        </section>
      )}
      <section className="flex flex-col gap-3">
        <p className="eyebrow">{t("ui.intel.title")}</p>
        {intel.map((event, index) => {
          const wolf = event.kind === "seer.result" && event.payload.role === "werewolf";
          return (
            <div
              className={`card flex gap-3.5 p-4 ${wolf ? "border-blood/35 bg-blood/10" : ""}`}
              key={event.id}
            >
              <span
                className={`w-11 flex-none pt-0.5 font-mono text-[11px] ${wolf ? "text-blood-light" : "text-fog-dim"}`}
              >
                {event.kind === "role.assigned"
                  ? "D0"
                  : event.kind === "harlot.result"
                    ? `N${snapshot.game.day}`
                    : `N${index + 1}`}
              </span>
              <span className="text-base leading-relaxed">{text(event)}</span>
            </div>
          );
        })}
      </section>
      <section className="flex flex-col gap-3">
        <p className="eyebrow">{t("ui.intel.villageAlive.count", { count: alive })}</p>
        <div className="grid grid-cols-5 gap-x-2 gap-y-3">
          {snapshot.players.map((player) => (
            <div
              className={`flex flex-col items-center gap-1.5 ${player.status === "dead" ? "opacity-40" : ""}`}
              key={player.userId}
            >
              <Avatar dead={player.status === "dead"} name={player.displayName} size="lg" />
              <span className="max-w-full truncate text-center text-[11px] text-fog">
                {player.displayName}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
