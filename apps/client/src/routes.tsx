import { useTranslation } from "react-i18next";

export type Route =
  | { type: "games" }
  | { type: "game"; id: string }
  | { type: "replay"; id: string };

export function currentRoute(pathname = window.location.pathname): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "games" && parts[1] && parts[2] === "replay")
    return { type: "replay", id: parts[1] };
  if (parts[0] === "games" && parts[1]) return { type: "game", id: parts[1] };
  return { type: "games" };
}

export function Routes({ route = currentRoute() }: { route?: Route }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm opacity-70">
      {route.type === "games"
        ? t("ui.waitingForPlayers")
        : route.type === "replay"
          ? t("ui.replay")
          : t("ui.lobby")}
    </p>
  );
}
