import type { ChatMessageId, UserId } from "@werewolf/protocol";
import { ChevronLeft, MessagesSquare, Plus, Swords, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { GlobalChatConnection } from "./api/chat-live.ts";
import {
  type ChatState,
  initialChatState,
  withHistory,
  withMessage,
  withOlderPage,
} from "./api/chat-state.ts";
import { api } from "./api/client.ts";
import { getSession, type Session } from "./auth/session.ts";
import { TabBar } from "./components.tsx";
import { i18n } from "./i18n/i18n.ts";
import { currentRoute, navigate } from "./routes.tsx";
import {
  CancelledScreen,
  CreateGameScreen,
  GameOverScreen,
  GameScreen,
  GamesScreen,
  GlobalChatScreen,
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

/** Single-use app-level escape hatch for game routes, which have no TabBar. */
function BackToGames() {
  const { t } = useTranslation();
  return (
    <button
      aria-label={t("ui.backToGames")}
      className="flex h-11 items-center gap-1.5 self-start text-fog"
      onClick={() => navigate("/")}
      type="button"
    >
      <ChevronLeft aria-hidden="true" size={18} strokeWidth={2} />
      {t("ui.tabs.games")}
    </button>
  );
}

function Shell() {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState(currentRoute());
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof api.getSnapshot>> | null>(
    null,
  );
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [chatSendError, setChatSendError] = useState<unknown>();
  const loadingOlder = useRef(false);
  // Mirrors `chat.cursor` outside the effect below, so a reconnect can read
  // the latest cursor without the effect depending on it — a dependency
  // there would tear down and rebuild the socket on every incoming message.
  const chatCursor = useRef<ChatMessageId>(0 as ChatMessageId);
  useEffect(() => {
    chatCursor.current = chat.cursor;
  }, [chat.cursor]);
  useEffect(() => {
    void getSession().then(setSession);
    const update = () => setRoute(currentRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    setChatSendError(undefined);
    if (route.type === "game" || route.type === "replay")
      void (route.type === "replay"
        ? api.getReplay(route.id).then((result) => setSnapshot(result.snapshot))
        : api.getSnapshot(route.id).then(setSnapshot));
  }, [route]);
  // The connection lives here rather than in the chat screen so it stays open
  // while the player browses games — presence will depend on that, and
  // messages accumulate meanwhile.
  const inLobby = route.type !== "game" && route.type !== "replay";
  const signedInWithUsername = session !== null && !!session.user.username;
  useEffect(() => {
    if (!inLobby || !signedInWithUsername) return;
    const connection = new GlobalChatConnection(
      {
        onHistory: (messages, cursor) =>
          setChat((current) => withHistory(current, messages, cursor)),
        onMessage: (message) => setChat((current) => withMessage(current, message)),
      },
      chatCursor.current,
    );
    connection.connect();
    return () => connection.close();
  }, [inLobby, signedInWithUsername]);
  const refreshSession = () => void getSession().then(setSession);
  const sendChatMessage = (text: string) =>
    api
      .sendChatMessage(text)
      .then((message) => {
        setChat((current) => withMessage(current, message));
        setChatSendError(undefined);
      })
      .catch((caught: unknown) => {
        setChatSendError(caught);
        throw caught;
      });
  const loadOlderChat = () => {
    const oldest = chat.messages[0];
    // Virtuoso fires startReached repeatedly while the reader sits at the top,
    // so without this guard one scroll issues a burst of identical requests.
    if (!oldest || loadingOlder.current) return;
    loadingOlder.current = true;
    void api
      .getChatHistory(oldest.id)
      .then((result) => setChat((current) => withOlderPage(current, result.messages)))
      .catch(() => undefined)
      .finally(() => {
        loadingOlder.current = false;
      });
  };

  if (session === null) return <SignInScreen />;
  if (!session.user.username) return <UsernameScreen onSaved={refreshSession} />;

  if (
    route.type === "games" ||
    route.type === "create" ||
    route.type === "chat" ||
    route.type === "profile"
  ) {
    const screen =
      route.type === "games" ? (
        <GamesScreen
          username={
            session.user.username ?? session.user.name ?? session.user.email ?? session.user.id
          }
        />
      ) : route.type === "create" ? (
        <CreateGameScreen />
      ) : route.type === "chat" ? (
        <GlobalChatScreen
          error={chatSendError}
          onLoadOlder={loadOlderChat}
          onSend={sendChatMessage}
          state={chat}
          viewerId={session.user.id as UserId}
        />
      ) : (
        <ProfileScreen
          onSignedOut={refreshSession}
          onUsernameSaved={refreshSession}
          user={session.user}
        />
      );
    return (
      <div className="screen">
        {screen}
        <TabBar
          current={route.type}
          items={[
            { id: "games", label: t("ui.tabs.games"), icon: Swords },
            { id: "create", label: t("ui.tabs.create"), icon: Plus },
            { id: "chat", label: t("ui.tabs.chat"), icon: MessagesSquare },
            { id: "profile", label: t("ui.tabs.profile"), icon: User },
          ]}
          onSelect={(id) => navigate(id === "games" ? "/" : `/${id}`)}
        />
      </div>
    );
  }

  return (
    <main className="screen">
      <div className="flex px-[18px] pt-2">
        <BackToGames />
      </div>
      {snapshot ? (
        route.type === "replay" ? (
          <GameOverScreen replay snapshot={snapshot} />
        ) : snapshot.game.status === "cancelled" ? (
          <CancelledScreen snapshot={snapshot} />
        ) : snapshot.game.status === "lobby" || snapshot.game.status === "scheduled" ? (
          <LobbyScreen onUpdate={setSnapshot} snapshot={snapshot} />
        ) : snapshot.game.status === "finished" ? (
          <GameOverScreen snapshot={snapshot} />
        ) : (
          <GameScreen initial={snapshot} />
        )
      ) : (
        <p className="px-[18px] text-fog">{"…"}</p>
      )}
    </main>
  );
}
