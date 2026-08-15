import { useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { api } from "./api/client.ts";
import { getSession, type Session } from "./auth/session.ts";
import { i18n } from "./i18n/i18n.ts";
import { currentRoute, navigate } from "./routes.tsx";
import { GameScreen, GamesScreen, LobbyScreen, SignInScreen, UsernameScreen } from "./screens.tsx";

export function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <Shell />
    </I18nextProvider>
  );
}

function Shell() {
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
    if (route.type !== "games")
      void (route.type === "replay"
        ? api.getReplay(route.id).then((result) => setSnapshot(result.state))
        : api.getSnapshot(route.id).then(setSnapshot));
  }, [route]);
  const open = (id: string) => navigate(`/games/${id}`);
  const home = route.type === "games";
  return (
    <div className="app-shell">
      <div aria-hidden="true" className="app-shell__atmosphere" />
      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          {home ? (
            <h1 className="font-display text-2xl font-semibold tracking-wide text-paper sm:text-3xl">
              Werewolf
            </h1>
          ) : (
            <button className="brand-control" onClick={() => navigate("/")} type="button">
              Werewolf
            </button>
          )}
          <SignInScreen onRefresh={() => void getSession().then(setSession)} session={session} />
        </header>
        {session && !session.user.username ? (
          <UsernameScreen onSaved={() => void getSession().then(setSession)} />
        ) : route.type === "games" ? (
          <GamesScreen onOpen={open} />
        ) : snapshot ? (
          route.type === "replay" ? (
            <GameScreen initial={snapshot} replay />
          ) : snapshot.game.status === "lobby" || snapshot.game.status === "scheduled" ? (
            <LobbyScreen onUpdate={setSnapshot} snapshot={snapshot} />
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
