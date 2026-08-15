import type { ViewerGameSnapshot } from "@werewolf/protocol";
import { useTranslation } from "react-i18next";

import { navigate } from "../routes.tsx";

/** A cancelled game is a dead end: name the game, then head back to the list. */
export function CancelledScreen({ snapshot }: { snapshot: ViewerGameSnapshot }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="screen__scroll flex flex-col gap-5 px-[18px] pb-5 pt-6">
        <header>
          <p className="eyebrow">
            {t("gameStatuses.cancelled")} · {snapshot.game.name}
          </p>
          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.03em]">
            {t("ui.cancelled.title")}
          </h1>
        </header>
        <p className="text-sm text-fog">{t("ui.cancelled.body")}</p>
      </div>
      <div className="flex gap-2.5 border-t border-paper/8 bg-bar px-[18px] py-3 pb-4">
        <button className="btn btn--primary flex-1" onClick={() => navigate("/")} type="button">
          {t("ui.backToGames")}
        </button>
      </div>
    </div>
  );
}
