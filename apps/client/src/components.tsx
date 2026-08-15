import type { GameEvent, GamePhase, ViewerGameSnapshot } from "@werewolf/protocol";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useState } from "react";
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

/* --- New primitives (design-system foundation) ---------------------------- */

export function Avatar({
  name,
  size = "md",
  dead = false,
}: {
  name: string;
  size?: "sm" | "md" | "lg" | "xl";
  dead?: boolean;
}) {
  return (
    <span aria-hidden="true" className={`avatar avatar--${size}${dead ? " avatar--dead" : ""}`}>
      {initialsOf(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 3 }: { names: string[]; max?: number }) {
  const visible = names.slice(0, max);
  const overflow = names.length - visible.length;
  // Names can repeat, so keys disambiguate duplicates with a per-name ordinal
  // instead of the array index.
  const seen = new Map<string, number>();
  return (
    <div aria-hidden="true" className="avatar-stack">
      {visible.map((name, index) => {
        const ordinal = (seen.get(name) ?? 0) + 1;
        seen.set(name, ordinal);
        return (
          <span
            className={`avatar avatar--sm${index > 0 ? " avatar--stacked" : ""}`}
            key={ordinal === 1 ? name : `${name}-${ordinal}`}
          >
            {initialsOf(name)}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="avatar avatar--sm avatar--stacked avatar--overflow">+{overflow}</span>
      )}
    </div>
  );
}

export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "active" | "lobby" | "running";
}) {
  return <span className={`chip${tone === "neutral" ? "" : ` chip--${tone}`}`}>{children}</span>;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={hint !== undefined ? `${label}, ${hint}` : label}
      className={`toggle${checked ? " toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className="toggle__thumb" />
    </button>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          className={`segmented__option${option.value === value ? " segmented__option--active" : ""}`}
          key={option.value}
        >
          <input
            checked={option.value === value}
            className="sr-only"
            name={label}
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

export function Stepper({
  label,
  value,
  onChange,
  step,
  min,
  max,
  unit,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step: number;
  min: number;
  max: number;
  unit: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <div className="stepper">
      <span className="stepper__label">{label}</span>
      <button
        aria-label={`${label} −`}
        className="stepper__btn"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        type="button"
      >
        −
      </button>
      <output aria-live="polite" className="stepper__value">
        {value}
        {unit}
      </output>
      <button
        aria-label={`${label} +`}
        className="stepper__btn"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        type="button"
      >
        +
      </button>
    </div>
  );
}

/** A live m:ss countdown. The skew between the client clock and the server
 * clock is captured once on mount, so the remaining time is always right no
 * matter how far apart the two clocks are, and it never runs below 0:00. */
export function Countdown({ endsAt, serverNow }: { endsAt: number; serverNow: number }) {
  const [now, setNow] = useState(() => Date.now());
  const [skew] = useState(() => Date.now() - serverNow);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((endsAt - now + skew) / 1000));
  const minutes = Math.floor(seconds / 60);
  return (
    <span className="countdown">
      {minutes}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

const PHASES: GamePhase[] = ["discussion", "voting", "night"];

export function PhaseTicks({ current }: { current: GamePhase }) {
  const activeIndex = PHASES.indexOf(current);
  return (
    <div aria-hidden="true" className={`phase-ticks phase-ticks--${current}`}>
      {PHASES.map((phase, index) => (
        <span
          className={`phase-ticks__tick ${index === activeIndex ? "phase-ticks__tick--active" : ""} ${
            index < activeIndex ? "phase-ticks__tick--past" : ""
          }`}
          key={phase}
        />
      ))}
    </div>
  );
}

export function PhaseHeader({ snapshot }: { snapshot: ViewerGameSnapshot }) {
  const { t } = useTranslation();
  const phase = snapshot.game.phase;
  if (!phase) return null;
  return (
    <div className="phase-header">
      <div className="phase-header__row">
        <span className="phase-header__title">
          <span
            aria-hidden="true"
            className={`phase-header__dot phase-header__dot--${phase.type}`}
          />
          {t("ui.day", { count: snapshot.game.day })} · {t(`phases.${phase.type}`)}
        </span>
        <Countdown endsAt={phase.endsAt} serverNow={snapshot.serverNow} />
      </div>
      <PhaseTicks current={phase.type} />
    </div>
  );
}

export function Meter({ value, max }: { value: number; max: number }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div aria-hidden="true" className="meter">
      <span className="meter__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function DividerNote({ children }: { children: ReactNode }) {
  return (
    <div className="divider-note">
      <span aria-hidden="true" className="divider-note__rule" />
      <span className="divider-note__text">{children}</span>
      <span aria-hidden="true" className="divider-note__rule" />
    </div>
  );
}

export function TabBar({
  items,
  current,
  onSelect,
}: {
  items: { id: string; label: string; glyph: "square" | "circle" | "diamond" }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="tabbar">
      {items.map((item) => (
        <button
          aria-current={item.id === current ? "page" : undefined}
          className={`tabbar__item${item.id === current ? " tabbar__item--active" : ""}`}
          key={item.id}
          onClick={() => onSelect(item.id)}
          type="button"
        >
          <span aria-hidden="true" className={`tabbar__glyph tabbar__glyph--${item.glyph}`} />
          {item.label}
        </button>
      ))}
    </nav>
  );
}
