import type { GamePhase, ViewerGameSnapshot } from "@werewolf/protocol";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiError } from "./api/client.ts";

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "·";
}

export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const code = (error as Partial<ApiError>).code ?? "UNKNOWN_ERROR";
  return (
    <p
      className="rounded-md border border-blood/50 bg-blood/15 px-3 py-2 text-sm text-paper"
      role="alert"
    >
      {t(`errors.${code}`, { defaultValue: t("errors.UNKNOWN_ERROR") })}
    </p>
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

/** One message row: avatar and author on the left for other people, a bare
 * right-aligned bubble for your own. Shared by the in-game Talk tab and the
 * global chat screen. */
export function ChatBubble({
  author,
  text,
  mine,
}: {
  author: string;
  text: string;
  mine: boolean;
}) {
  return (
    <div className={`flex gap-2.5 ${mine ? "justify-end" : ""}`}>
      {!mine && <Avatar name={author} size="sm" />}
      <div className={`flex max-w-[82%] flex-col ${mine ? "items-end" : ""}`}>
        {!mine && <span className="mb-[5px] font-mono text-[11px] text-fog">{author}</span>}
        <div className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"}`}>{text}</div>
      </div>
    </div>
  );
}

/** The message input and its send button. `className` carries the wrapper's
 * positioning because the two callers differ: the Talk tab sticks it to the
 * bottom of a scrolling page, the global chat screen is a flex sibling of a
 * virtualized list. */
export function ChatComposer({
  className,
  disabled = false,
  inputId,
  label,
  placeholder,
  sendLabel,
  onSend,
}: {
  className: string;
  disabled?: boolean;
  inputId: string;
  label: string;
  placeholder: string;
  sendLabel: string;
  // A union of two function types, not one function returning a union: Talk's
  // plain event handler infers a `void` return and only a `void`-return
  // function type accepts it, while the chat screen's returns a promise the
  // composer awaits before clearing.
  onSend: ((text: string) => void) | ((text: string) => Promise<unknown>);
}) {
  const [text, setText] = useState("");
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || text.trim() === "") return;
        const submitted = text;
        void (async () => {
          try {
            await Promise.resolve(onSend(submitted));
            setText("");
          } catch {
            // Leave the typed text in place; the caller surfaces the error.
          }
        })();
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        className="min-h-12 flex-1 rounded-full bg-surface-raised px-[18px] text-paper placeholder:text-fog-dim disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        id={inputId}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        value={text}
      />
      <button
        aria-label={sendLabel}
        className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-blood text-bone disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        type="submit"
      >
        <span aria-hidden="true" className="text-[18px]">
          ↑
        </span>
      </button>
    </form>
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
  items: { id: string; label: string; icon: LucideIcon; badge?: boolean }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="tabbar">
      {items.map(({ id, label, icon: Icon, badge }) => (
        <button
          aria-current={id === current ? "page" : undefined}
          className={`tabbar__item${id === current ? " tabbar__item--active" : ""}`}
          key={id}
          onClick={() => onSelect(id)}
          type="button"
        >
          <span className="tabbar__glyph-wrap">
            <Icon aria-hidden="true" className="tabbar__glyph" size={18} strokeWidth={2} />
            {badge && <span aria-hidden="true" className="tabbar__badge" />}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}
