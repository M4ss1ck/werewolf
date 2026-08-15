import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api/client.ts";
import { ErrorMessage } from "../components.tsx";

const USERNAME_MAX = 24;

/** Design 02 · shown while the session has no username yet. */
export function UsernameScreen({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [error, setError] = useState<unknown>();
  const valid = username.trim().length >= 3;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.setUsername(username.trim());
      onSaved();
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="screen">
      <form
        className="mx-auto flex w-full max-w-[30rem] flex-col gap-6 px-6 py-8"
        onSubmit={(event) => void save(event)}
      >
        <div>
          <h1 className="text-[30px] font-semibold tracking-[-0.03em]">{t("ui.chooseUsername")}</h1>
          <p className="mt-2.5 text-[15px] leading-relaxed text-fog">
            {t("ui.chooseUsernameIntro")}
          </p>
        </div>
        <div className="flex flex-col gap-2.5">
          <label className="field-label" htmlFor="username">
            {t("ui.username")}
          </label>
          <input
            className="field-input"
            id="username"
            maxLength={USERNAME_MAX}
            minLength={3}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t("ui.usernamePlaceholder")}
            required
            style={{ fontSize: 19, minHeight: 60 }}
            value={username}
          />
          <div className="flex justify-between text-[13px] text-fog">
            <span>{t("ui.usernameHint")}</span>
            <span className="font-mono">
              {username.length}/{USERNAME_MAX}
            </span>
          </div>
        </div>
        <ErrorMessage error={error} />
        <button
          className={`btn btn--primary w-full${valid ? "" : " btn--disabled"}`}
          disabled={!valid}
          style={{ fontSize: 16, fontWeight: 600, minHeight: 56 }}
          type="submit"
        >
          {t("ui.saveUsername")}
        </button>
      </form>
    </div>
  );
}
