import type { Locale } from "@werewolf/i18n";
import type { MeStats } from "@werewolf/protocol";
import { Pencil } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import type { SessionUser } from "../auth/session.ts";
import { Avatar, ErrorMessage, Segmented, Toggle } from "../components.tsx";
import { changeLocale } from "../i18n/i18n.ts";

const PREFS = {
  notifications: "werewolf.prefs.notifications",
  reducedMotion: "werewolf.prefs.reducedMotion",
} as const;

function StatTile({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="flex-1 rounded-[14px] border border-paper/10 bg-surface p-4">
      <div className="font-mono text-2xl">{value}</div>
      <div className="mt-1 text-[13px] text-fog">{label}</div>
    </div>
  );
}

/** Design 11 · profile and client-local settings. */
export function ProfileScreen({
  user,
  onSignedOut,
  onUsernameSaved,
}: {
  user: SessionUser;
  onSignedOut: () => void;
  onUsernameSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [stats, setStats] = useState<MeStats | null>(null);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem(PREFS.notifications) === "true",
  );
  const [reducedMotion, setReducedMotion] = useState(
    () => localStorage.getItem(PREFS.reducedMotion) === "true",
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    void api
      .getStats()
      .then(setStats)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reducedMotion);
  }, [reducedMotion]);
  const survived =
    stats !== null && stats.games > 0 ? Math.round((stats.survived / stats.games) * 100) : 0;
  const displayName = user.username ?? user.name ?? user.email ?? user.id;
  const valid = draft.trim().length >= 3;
  const closeEditor = () => {
    setDraft("");
    setError(undefined);
    setEditing(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.setUsername(draft.trim());
      setError(undefined);
      setEditing(false);
      onUsernameSaved();
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="screen__scroll flex flex-col gap-6 px-4.5 pb-5 pt-6">
      <header className="flex items-center gap-4">
        <Avatar name={displayName} size="xl" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form className="flex flex-col gap-1.5" onSubmit={(event) => void save(event)}>
              <div className="flex items-center gap-2">
                <input
                  aria-label={t("ui.username")}
                  className="field-input min-w-0 flex-1"
                  maxLength={24}
                  minLength={3}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeEditor();
                  }}
                  required
                  value={draft}
                />
                <button className="btn btn--sm" onClick={closeEditor} type="button">
                  {t("ui.cancel")}
                </button>
                <button
                  className={`btn btn--sm btn--primary${valid ? "" : " btn--disabled"}`}
                  disabled={!valid}
                  type="submit"
                >
                  {t("ui.save")}
                </button>
              </div>
              <div className="flex justify-between text-[13px] text-fog">
                <span>{t("ui.usernameHint")}</span>
                <span className="font-mono">{draft.length}/24</span>
              </div>
              <ErrorMessage error={error} />
            </form>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[26px] font-semibold tracking-[-0.03em]">
                  {displayName}
                </h1>
                <button
                  aria-label={t("ui.profile.editUsername")}
                  className="text-fog transition-colors hover:text-paper"
                  onClick={() => {
                    setDraft(user.username ?? "");
                    setError(undefined);
                    setEditing(true);
                  }}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={16} />
                </button>
              </div>
              {user.email !== undefined && (
                <p className="mt-1 font-mono text-xs text-fog">{user.email}</p>
              )}
            </>
          )}
        </div>
      </header>
      <div className="flex gap-2.5">
        <StatTile label={t("ui.profile.games")} value={stats?.games ?? "–"} />
        <StatTile label={t("ui.profile.survived")} value={stats === null ? "–" : `${survived}%`} />
        <StatTile label={t("ui.profile.asWolf")} value={stats?.asWolf ?? "–"} />
      </div>
      <div className="flex flex-col gap-3">
        <div className="eyebrow">{t("ui.profile.settings")}</div>
        <div className="overflow-hidden rounded-[14px] border border-paper/10 bg-surface">
          <div className="flex items-center justify-between gap-4 border-b border-paper/5 px-4.5 py-4">
            <span className="text-base">{t("ui.profile.language")}</span>
            <Segmented
              label={t("ui.profile.language")}
              onChange={(value) => void changeLocale(value as Locale)}
              options={[
                { value: "en", label: "EN" },
                { value: "es", label: "ES" },
              ]}
              value={i18n.language}
            />
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-paper/5 px-4.5 py-4">
            <div>
              <div className="text-base">{t("ui.profile.phaseNotifications")}</div>
              <div className="mt-0.5 text-[13px] text-fog">
                {t("ui.profile.phaseNotificationsHint")}
              </div>
            </div>
            <Toggle
              checked={notifications}
              hint={t("ui.profile.phaseNotificationsHint")}
              label={t("ui.profile.phaseNotifications")}
              onChange={(next) => {
                setNotifications(next);
                localStorage.setItem(PREFS.notifications, String(next));
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4.5 py-4">
            <div>
              <div className="text-base">{t("ui.profile.reducedMotion")}</div>
              <div className="mt-0.5 text-[13px] text-fog">{t("ui.profile.reducedMotionHint")}</div>
            </div>
            <Toggle
              checked={reducedMotion}
              hint={t("ui.profile.reducedMotionHint")}
              label={t("ui.profile.reducedMotion")}
              onChange={(next) => {
                setReducedMotion(next);
                localStorage.setItem(PREFS.reducedMotion, String(next));
              }}
            />
          </div>
        </div>
      </div>
      <button
        className="btn btn--danger w-full"
        onClick={() =>
          void import("../auth/session.ts").then(({ signOut }) => signOut()).then(onSignedOut)
        }
        type="button"
      >
        {t("ui.profile.signOut")}
      </button>
    </div>
  );
}
