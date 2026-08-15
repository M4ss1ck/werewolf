import { useEffect, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";

import { api } from "./api/client.ts";
import { getSession, type Session } from "./auth/session.ts";
import { TabBar } from "./components.tsx";
import { i18n } from "./i18n/i18n.ts";
import { currentRoute, navigate } from "./routes.tsx";
import {
  CreateGameScreen,
  GameOverScreen,
  GameScreen,
  GamesScreen,
  LobbyScreen,
  ProfileScreen,
  SignInScreen,
  UsernameScreen,
} from "./screens/index.ts";

export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <Shell />
    </I18nextProvider>
  );
}

function Shell() {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState(currentRoute());
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof api.getSnapshot>> | null>(
    null,
  );
  useEffect(() => {
    void getSession().then(setSession);
    const update = () => setRoute(currentRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (route.type === "game" || route.type === "replay")
      void (route.type === "replay"
        ? api.getReplay(route.id).then((result) => setSnapshot(result.snapshot))
        : api.getSnapshot(route.id).then(setSnapshot));
  }, [route]);
  const refreshSession = () => void getSession().then(setSession);

  if (session === null) return <SignInScreen />;
  if (!session.user.username) return <UsernameScreen onSaved={refreshSession} />;

  if (route.type === "games" || route.type === "create" || route.type === "profile") {
    const screen =
      route.type === "games" ? (
        <GamesScreen
          username={
            session.user.username ?? session.user.name ?? session.user.email ?? session.user.id
          }
        />
      ) : route.type === "create" ? (
        <CreateGameScreen />
      ) : (
        <ProfileScreen onSignedOut={refreshSession} user={session.user} />
      );
    return (
      <div className="screen mx-auto w-full max-w-[480px]">
        {screen}
        <TabBar
          current={route.type}
          items={[
            { id: "games", label: t("ui.tabs.games"), glyph: "square" },
            { id: "create", label: t("ui.tabs.create"), glyph: "square" },
            { id: "profile", label: t("ui.tabs.profile"), glyph: "circle" },
          ]}
          onSelect={(id) => navigate(id === "games" ? "/" : `/${id}`)}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div aria-hidden="true" className="app-shell__atmosphere" />
      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        {snapshot ? (
          route.type === "replay" ? (
            <GameOverScreen snapshot={snapshot} />
          ) : snapshot.game.status === "lobby" || snapshot.game.status === "scheduled" ? (
            <LobbyScreen onUpdate={setSnapshot} snapshot={snapshot} />
          ) : snapshot.game.status === "finished" ? (
            <GameOverScreen snapshot={snapshot} />
          ) : (
            <GameScreen initial={snapshot} />
          )
        ) : (
          <p className="text-fog">{"…"}</p>
        )}
      </main>
    </div>
  );
}
