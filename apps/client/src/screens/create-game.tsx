import type { TFunction } from "i18next";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { ErrorMessage, Segmented, Stepper, Toggle } from "../components.tsx";
import { navigate } from "../routes.tsx";

const SCHEDULE_PRESETS = [2, 5, 10, 30, 60] as const;
type Schedule = "manual" | "custom" | (typeof SCHEDULE_PRESETS)[number];

/** The absolute start time a schedule choice means right now, if any. */
function scheduledAtFor(schedule: Schedule, customAt: string): number | undefined {
  if (schedule === "manual") return undefined;
  if (schedule === "custom") {
    const parsed = Date.parse(customAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return Date.now() + schedule * 60_000;
}

function scheduleLabel(
  option: "manual" | "custom" | (typeof SCHEDULE_PRESETS)[number],
  t: TFunction,
) {
  if (option === "manual") return t("ui.scheduleManual");
  if (option === "custom") return t("ui.schedulePickTime");
  if (option === 60) return t("ui.scheduleInHour");
  return t("ui.scheduleInMinutes.count", { count: option });
}

/** Design 04 · create a game. */
export function CreateGameScreen() {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [spectatingEnabled, setSpectatingEnabled] = useState(true);
  const [schedule, setSchedule] = useState<Schedule>("manual");
  const [customAt, setCustomAt] = useState("");
  const [durations, setDurations] = useState({ discussion: 120, voting: 60, night: 60 });
  const [error, setError] = useState<unknown>();
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const startsAt = scheduledAtFor(schedule, customAt);
    if (schedule === "custom" && (startsAt === undefined || startsAt <= Date.now())) return;
    try {
      const { gameId } = await api.createGame({
        name,
        visibility,
        ...(startsAt ? { scheduledAt: startsAt } : {}),
        settings: { ...durations, spectatingEnabled },
      });
      navigate(`/games/${gameId}`);
    } catch (caught) {
      setError(caught);
    }
  };
  const setDuration = (key: keyof typeof durations, value: number) =>
    setDurations((current) => ({ ...current, [key]: value }));
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void create(event)}>
      <div className="screen__scroll flex flex-col gap-6 px-4.5 pb-5 pt-6">
        <h1 className="text-[30px] font-semibold tracking-[-0.03em]">{t("ui.createGame")}</h1>
        <div className="flex flex-col gap-2.5">
          <label className="field-label" htmlFor="create-name">
            {t("ui.gameName")}
          </label>
          <input
            className="field-input"
            id="create-name"
            onChange={(event) => setName(event.target.value)}
            placeholder={t("ui.gameNamePlaceholder")}
            required
            value={name}
          />
        </div>
        <Segmented
          label={t("ui.visibility")}
          onChange={(value) => setVisibility(value as "public" | "private")}
          options={[
            { value: "public", label: t("ui.visibilityPublic") },
            { value: "private", label: t("ui.visibilityPrivate") },
          ]}
          value={visibility}
        />
        <div className="flex items-center justify-between gap-4 rounded-[14px] border border-paper/10 bg-surface px-4.5 py-4">
          <div>
            <div className="text-base font-medium">{t("ui.allowSpectating")}</div>
            <div className="mt-0.5 text-[13px] text-fog">{t("ui.allowSpectatingHint")}</div>
          </div>
          <Toggle
            checked={spectatingEnabled}
            hint={t("ui.allowSpectatingHint")}
            label={t("ui.allowSpectating")}
            onChange={setSpectatingEnabled}
          />
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="field-label">{t("ui.scheduledStart")}</legend>
          <div className="flex flex-wrap gap-2">
            {(["manual", ...SCHEDULE_PRESETS, "custom"] as const).map((option) => (
              <label
                className={`chip cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-sage${
                  schedule === option ? " chip--active" : ""
                }`}
                key={option}
              >
                <input
                  checked={schedule === option}
                  className="sr-only"
                  name="schedule"
                  onChange={() => setSchedule(option)}
                  type="radio"
                  value={String(option)}
                />
                {scheduleLabel(option, t)}
              </label>
            ))}
          </div>
          {schedule === "custom" && (
            <input
              aria-label={t("ui.schedulePickTime")}
              className="field-input"
              id="create-scheduled"
              onChange={(event) => setCustomAt(event.target.value)}
              type="datetime-local"
              value={customAt}
            />
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="field-label">{t("ui.phaseDurations")}</legend>
          <Stepper
            label={t("phases.discussion")}
            max={600}
            min={15}
            onChange={(value) => setDuration("discussion", value)}
            step={15}
            unit={t("ui.secondsShort")}
            value={durations.discussion}
          />
          <Stepper
            label={t("phases.voting")}
            max={600}
            min={15}
            onChange={(value) => setDuration("voting", value)}
            step={15}
            unit={t("ui.secondsShort")}
            value={durations.voting}
          />
          <Stepper
            label={t("phases.night")}
            max={600}
            min={15}
            onChange={(value) => setDuration("night", value)}
            step={15}
            unit={t("ui.secondsShort")}
            value={durations.night}
          />
        </fieldset>
        <ErrorMessage error={error} />
      </div>
      <div className="border-t border-paper/8 bg-bar px-4.5 py-3 pb-4">
        <button className="btn btn--primary w-full" type="submit">
          {t("ui.createGame")}
        </button>
      </div>
    </form>
  );
}
