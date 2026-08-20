import type { Locale } from "@werewolf/i18n";
import { useTranslation } from "react-i18next";

import { Segmented } from "../components.tsx";
import { changeLocale } from "../i18n/i18n.ts";

/** Design 01 · full-bleed sign-in. No session yet, so the language pair only
 * stores the preference — there is nothing on the server to patch. */
export function SignInScreen({ error }: { error?: string | undefined }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="screen">
      <div className="flex w-full flex-1 flex-col justify-between px-6 pb-8 pt-12">
        <div className="flex flex-col gap-7 pt-10">
          <span
            aria-hidden="true"
            className="h-16 w-16 rounded-full bg-paper shadow-[0_0_60px_rgba(233,229,218,.22)]"
          />
          <div>
            <h1 className="text-[44px] font-semibold leading-none tracking-[-0.035em]">Werewolf</h1>
            <p className="mt-3.5 max-w-75 text-[17px] leading-relaxed text-fog">
              {t("ui.homeTagline")}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3.5">
          {error ? (
            <p
              className="rounded-md border border-blood/50 bg-blood/15 px-3 py-2 text-sm text-paper"
              role="alert"
            >
              {t("ui.signInFailed")} ({error})
            </p>
          ) : null}
          <button
            className="btn btn--primary w-full"
            onClick={() =>
              void import("../auth/session.ts").then(({ signInWithGoogle }) => signInWithGoogle())
            }
            type="button"
          >
            {t("ui.signIn")} · Google
          </button>
          <Segmented
            label={t("ui.language")}
            onChange={(value) => void changeLocale(value as Locale, false)}
            options={[
              { value: "en", label: "EN" },
              { value: "es", label: "ES" },
            ]}
            value={i18n.language}
          />
        </div>
      </div>
    </div>
  );
}
