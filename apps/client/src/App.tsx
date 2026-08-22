import type {
  ChatContent,
  ChatMessage,
  ChatMessageId,
  ChatServerFrame,
  UserId,
} from "@werewolf/protocol";
import { normalizeMentionSearch } from "@werewolf/protocol";
import { ChevronLeft, MessagesSquare, Plus, Swords, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { type AuthDeepLinkResult, listenForAuthDeepLinks } from "./auth/deep-link.ts";
import { listenForLoopbackCallback } from "./auth/loopback.ts";
import { getSession, type Session } from "./auth/session.ts";
import { listenForTelegramCallback } from "./auth/telegram.ts";
import { type ChatViewportSnapshot, loadStoredReadState, useChatReadStore } from "./chat/index.ts";
import type { MentionCandidate } from "./chat/mentions.ts";
import { type ChatDraft, EMPTY_CHAT_DRAFT, globalChatRow } from "./chat/model.ts";
import {
  markThrough as advanceReadThrough,
  markVisible as advanceReadVisible,
  type ConversationReadState,
  rebaseRetainedState,
  unreadSummary,
} from "./chat/read-state.ts";
import { TabBar } from "./components.tsx";
import { i18n } from "./i18n/i18n.ts";
import { currentRoute, navigate, type Route, sameRoute } from "./routes.tsx";
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
  const [session, setSession] = useState<Session | null>(null);
  const refreshSession = () => void getSession().then(setSession);
  const refreshSessionRef = useRef(refreshSession);
  refreshSessionRef.current = refreshSession;
  const [signInError, setSignInError] = useState<string | undefined>();

  useEffect(() => {
    void getSession().then(setSession);
  }, []);

  useEffect(() => {
    const onResult = (result: AuthDeepLinkResult) => {
      if (result.ok) {
        setSignInError(undefined);
        refreshSessionRef.current();
      } else if (result.code !== "IGNORED") {
        setSignInError(result.code);
      }
    };
    const stopDeepLinks = listenForAuthDeepLinks(onResult);
    const stopLoopback = listenForLoopbackCallback(onResult);
    const stopTelegram = listenForTelegramCallback(onResult);
    return () => {
      stopDeepLinks();
      stopLoopback();
      stopTelegram();
    };
  }, []);

  if (session === null) return <SignInScreen error={signInError} />;
  if (!session.user.username) return <UsernameScreen onSaved={refreshSession} />;
  return (
    <SignedInShell key={session.user.id} onRefreshSession={refreshSession} session={session} />
  );
}

function initialReadCursor(userId: UserId): ChatMessageId | undefined {
  try {
    const state = loadStoredReadState(window.localStorage, userId, "global");
    return state?.readThrough === undefined ? undefined : (state.readThrough as ChatMessageId);
  } catch {
    return undefined;
  }
}

function writeStoredGlobalReadState(
  userId: UserId,
  state: ConversationReadState,
  latestTouchedAt = Date.now(),
  onlyIfReadThroughAtMost?: number,
): boolean {
  try {
    const key = `werewolf.chat-read.v1:${encodeURIComponent(userId)}:global`;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return false;
    const record: unknown = JSON.parse(raw);
    if (typeof record !== "object" || record === null) return false;
    const existingReadThrough = (record as Record<string, unknown>).readThrough;
    if (
      typeof existingReadThrough === "number" &&
      ((onlyIfReadThroughAtMost !== undefined && existingReadThrough > onlyIfReadThroughAtMost) ||
        (onlyIfReadThroughAtMost === undefined && existingReadThrough > state.readThrough))
    ) {
      return false;
    }
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...(record as Record<string, unknown>),
        readThrough: state.readThrough,
        seenAfter: state.seenAfter,
        touchedAt: latestTouchedAt,
      }),
    );
    return true;
  } catch {
    // An unavailable storage adapter is treated as absent state.
    return false;
  }
}

function resetStoredGlobalFrontier(
  userId: UserId,
  latestId: ChatMessageId,
  expectedReadThrough: number,
): boolean {
  return writeStoredGlobalReadState(
    userId,
    { readThrough: latestId, seenAfter: [] },
    Date.now(),
    expectedReadThrough,
  );
}

function withPostedMessage(state: ChatState, message: ChatMessage): ChatState {
  const next = withOlderPage(state, [message]);
  return {
    ...next,
    cursor: Math.max(state.cursor, message.id) as ChatMessageId,
    hasOlder: state.hasOlder,
  };
}

function SignedInShell({
  session,
  onRefreshSession,
}: {
  session: Session;
  onRefreshSession: () => void;
}) {
  const { t } = useTranslation();
  const userId = session.user.id as UserId;
  const username = session.user.username!;
  const [route, setRoute] = useState<Route>(currentRoute());
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof api.getSnapshot>> | null>(
    null,
  );
  const [snapshotRouteKey, setSnapshotRouteKey] = useState<string>();
  const [snapshotError, setSnapshotError] = useState<{ key: string; error: unknown }>();
  const snapshotRequest = useRef(0);
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const chatRef = useRef(chat);
  const [chatSendError, setChatSendError] = useState<unknown>();
  const [draft, setDraft] = useState<ChatDraft>(EMPTY_CHAT_DRAFT);
  const [viewport, setViewport] = useState<ChatViewportSnapshot | undefined>();
  const [jumpToLatestToken, setJumpToLatestToken] = useState(0);
  const [candidateRefreshToken, setCandidateRefreshToken] = useState(0);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const candidateQuery = useRef<string | undefined>(undefined);
  const candidateRequest = useRef(0);
  const loadingOlder = useRef(false);
  const deliveryCursor = useRef<ChatMessageId>(0 as ChatMessageId);
  const pendingMarkThrough = useRef<ChatMessageId | undefined>(undefined);
  const [readReset, setReadReset] = useState<ConversationReadState | undefined>();
  const readResetRef = useRef(readReset);
  readResetRef.current = readReset;
  const readStore = useChatReadStore(userId);
  const readStoreRef = useRef(readStore);
  readStoreRef.current = readStore;

  useEffect(() => {
    // Keep the current object when the URL still resolves to the same route.
    // The snapshot effect below keys on `route`, so a fresh object for an
    // unchanged route re-runs it and fires a second GET for the same game.
    const update = () =>
      setRoute((current) => {
        const next = currentRoute();
        return sameRoute(current, next) ? current : next;
      });
    window.addEventListener("popstate", update);
    // The route was read during render, and nothing was listening between then
    // and now. Re-read it, or a navigation landing in that window is lost and
    // the URL and the screen disagree for the rest of the session.
    update();
    return () => window.removeEventListener("popstate", update);
  }, []);

  useEffect(() => {
    setChatSendError(undefined);
    const requestId = ++snapshotRequest.current;
    setSnapshot(null);
    setSnapshotRouteKey(undefined);
    setSnapshotError(undefined);
    if (route.type !== "game" && route.type !== "replay") return;
    const routeKey = `${route.type}:${route.id}`;
    const request =
      route.type === "replay"
        ? api.getReplay(route.id).then((result) => result.snapshot)
        : api.getSnapshot(route.id);
    void request
      .then((result) => {
        if (requestId !== snapshotRequest.current) return;
        setSnapshot(result);
        setSnapshotRouteKey(routeKey);
      })
      .catch((error: unknown) => {
        if (requestId !== snapshotRequest.current) return;
        setSnapshot(null);
        setSnapshotError({ key: routeKey, error });
      });
  }, [route]);

  const chatRows = useMemo(() => chat.messages.map(globalChatRow), [chat.messages]);
  const readState = readReset ?? readStore.states.global ?? { readThrough: 0, seenAfter: [] };
  const globalUnread = unreadSummary(readState, chatRows, userId);
  const recentUserIds = useMemo(
    () => [...new Set([...chat.messages].reverse().map((message) => message.userId))],
    [chat.messages],
  );
  const mentionSource = useMemo(
    () => ({
      kind: "remote" as const,
      search: (query: string, signal: AbortSignal) => {
        const normalizedQuery = normalizeMentionSearch(query.trim());
        const requestId = ++candidateRequest.current;
        if (candidateQuery.current !== normalizedQuery) setMentionCandidates([]);
        return api.getMentionCandidates(query, signal).then((candidates) => {
          const normalized = candidates.map((candidate) => ({
            userId: candidate.userId,
            displayName: candidate.displayName,
            ...(candidate.status === undefined ? {} : { status: candidate.status }),
            ...(candidate.isBot === undefined ? {} : { isBot: candidate.isBot }),
          }));
          if (signal.aborted || requestId !== candidateRequest.current) return normalized;
          candidateQuery.current = normalizedQuery;
          setMentionCandidates(normalized);
          return normalized;
        });
      },
      recentUserIds,
      refreshToken: candidateRefreshToken,
    }),
    [candidateRefreshToken, recentUserIds],
  );

  useEffect(() => {
    deliveryCursor.current = chat.cursor;
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    const pending = pendingMarkThrough.current;
    if (pending === undefined || !chat.messages.some((message) => message.id === pending)) return;
    pendingMarkThrough.current = undefined;
    if (readResetRef.current !== undefined) {
      const stored = loadStoredReadState(window.localStorage, userId, "global");
      const current =
        stored !== undefined && stored.readThrough > readResetRef.current.readThrough
          ? stored
          : readResetRef.current;
      const next = advanceReadThrough(current, pending);
      readResetRef.current = next;
      setReadReset(next);
      writeStoredGlobalReadState(userId, next);
      return;
    }
    readStoreRef.current.markThrough("global", pending);
  }, [chat.messages, userId]);

  // The username is part of the authenticated socket identity. Keep it in the
  // lifecycle key even though the socket handshake itself uses the session
  // credentials rather than sending it as a frame field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the authenticated username intentionally keys this connection lifecycle
  useEffect(() => {
    const history = (frame: Extract<ChatServerFrame, { type: "history" }>) => {
      const next = withHistory(chatRef.current, frame);
      chatRef.current = next;
      setChat(next);
      const rows = next.messages.map(globalChatRow);
      const stored = loadStoredReadState(window.localStorage, userId, "global");
      const frontierNeedsReset = stored !== undefined && stored.readThrough > frame.cursor;
      readStoreRef.current.establishBaseline("global", rows);
      const resetSucceeded =
        frontierNeedsReset &&
        resetStoredGlobalFrontier(
          userId,
          frame.cursor,
          readResetRef.current?.readThrough ?? stored!.readThrough,
        );
      readStoreRef.current.rebaseRetention("global", rows, frame.oldestRetainedId, frame.cursor);
      if (resetSucceeded) {
        readResetRef.current = undefined;
        setReadReset(undefined);
      } else if (readResetRef.current !== undefined) {
        const current =
          stored !== undefined && stored.readThrough > readResetRef.current.readThrough
            ? stored
            : readResetRef.current;
        const rebased = rebaseRetainedState(
          current,
          rows,
          userId,
          frame.oldestRetainedId,
          frame.cursor,
        );
        readResetRef.current = rebased;
        setReadReset(rebased);
        writeStoredGlobalReadState(userId, rebased);
      }
    };
    const connection = new GlobalChatConnection(
      {
        onHistory: history,
        onMessage: (message) => {
          const next = withMessage(chatRef.current, message);
          chatRef.current = next;
          setChat(next);
        },
      },
      deliveryCursor.current,
      initialReadCursor(userId),
    );
    connection.connect();
    return () => connection.close();
  }, [userId, username]);

  const markGlobalThrough = (latestId: number) => {
    if (readResetRef.current !== undefined) {
      const stored = loadStoredReadState(window.localStorage, userId, "global");
      const current =
        stored !== undefined && stored.readThrough > readResetRef.current.readThrough
          ? stored
          : readResetRef.current;
      const next = advanceReadThrough(current, latestId);
      readResetRef.current = next;
      setReadReset(next);
      writeStoredGlobalReadState(userId, next);
      return;
    }
    readStoreRef.current.markThrough("global", latestId);
  };

  const markGlobalVisible = (ids: number[]) => {
    if (readResetRef.current !== undefined) {
      const stored = loadStoredReadState(window.localStorage, userId, "global");
      const current =
        stored !== undefined && stored.readThrough > readResetRef.current.readThrough
          ? stored
          : readResetRef.current;
      const next = advanceReadVisible(current, chatRows, userId, ids);
      readResetRef.current = next;
      setReadReset(next);
      writeStoredGlobalReadState(userId, next);
      return;
    }
    readStoreRef.current.markVisible("global", chatRows, ids);
  };

  const onSend = async (content: ChatContent) => {
    const message = await api.sendChatMessage(content);
    const wasPresent = chatRef.current.messages.some((row) => row.id === message.id);
    const next = withPostedMessage(chatRef.current, message);
    chatRef.current = next;
    setChat(next);
    setChatSendError(undefined);
    if (wasPresent) {
      markGlobalThrough(message.id);
    } else if (next.messages.some((row) => row.id === message.id)) {
      pendingMarkThrough.current = message.id;
    }
    setJumpToLatestToken((token) => token + 1);
  };

  const loadOlderChat = () => {
    const oldest = chatRef.current.messages[0];
    if (!oldest || loadingOlder.current) return;
    loadingOlder.current = true;
    void api
      .getChatHistory(oldest.id)
      .then((result) => {
        const next = withOlderPage(chatRef.current, result.messages);
        chatRef.current = next;
        setChat(next);
      })
      .catch(() => undefined)
      .finally(() => {
        loadingOlder.current = false;
      });
  };

  if (
    route.type === "games" ||
    route.type === "create" ||
    route.type === "chat" ||
    route.type === "profile"
  ) {
    const screen =
      route.type === "games" ? (
        <GamesScreen username={username ?? session.user.name ?? session.user.email ?? userId} />
      ) : route.type === "create" ? (
        <CreateGameScreen />
      ) : route.type === "chat" ? (
        <GlobalChatScreen
          candidates={mentionCandidates}
          draft={draft}
          error={chatSendError}
          jumpToLatestToken={jumpToLatestToken}
          mentionSource={mentionSource}
          onDraftChange={setDraft}
          onError={(error) => setChatSendError(error)}
          onInvalidMention={() => setCandidateRefreshToken((token) => token + 1)}
          onLoadOlder={loadOlderChat}
          onMarkThrough={markGlobalThrough}
          onSend={onSend}
          onSent={() => undefined}
          onSnapshot={setViewport}
          onVisible={markGlobalVisible}
          readState={readState}
          state={chat}
          {...(viewport === undefined ? {} : { viewport })}
          viewerId={userId}
        />
      ) : (
        <ProfileScreen
          onSignedOut={onRefreshSession}
          onUsernameSaved={onRefreshSession}
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
            {
              id: "chat",
              label: t("ui.tabs.chat"),
              icon: MessagesSquare,
              badge:
                globalUnread.count > 0
                  ? { kind: "count", count: globalUnread.count, mentioned: globalUnread.mentioned }
                  : undefined,
            },
            { id: "profile", label: t("ui.tabs.profile"), icon: User },
          ]}
          onSelect={(id) => navigate(id === "games" ? "/" : `/${id}`)}
        />
      </div>
    );
  }

  const routeSnapshotKey =
    route.type === "game" || route.type === "replay" ? `${route.type}:${route.id}` : undefined;
  const renderedSnapshot = snapshotRouteKey === routeSnapshotKey ? snapshot : null;
  const renderedSnapshotError =
    routeSnapshotKey !== undefined && snapshotError?.key === routeSnapshotKey
      ? snapshotError.error
      : undefined;

  return (
    <main className="screen">
      <div className="flex px-4.5 pt-2">
        <BackToGames />
      </div>
      {renderedSnapshot ? (
        route.type === "replay" ? (
          <GameOverScreen replay snapshot={renderedSnapshot} />
        ) : renderedSnapshot.game.status === "cancelled" ? (
          <CancelledScreen snapshot={renderedSnapshot} />
        ) : renderedSnapshot.game.status === "lobby" ||
          renderedSnapshot.game.status === "scheduled" ? (
          <LobbyScreen onUpdate={setSnapshot} snapshot={renderedSnapshot} />
        ) : renderedSnapshot.game.status === "finished" ? (
          <GameOverScreen snapshot={renderedSnapshot} />
        ) : (
          <GameScreen
            initial={renderedSnapshot}
            key={renderedSnapshot.game.id}
            onUpdate={setSnapshot}
            readStore={readStore}
          />
        )
      ) : renderedSnapshotError ? (
        <p className="px-4.5 text-fog" role="alert">
          {typeof renderedSnapshotError === "object" &&
          renderedSnapshotError !== null &&
          "code" in renderedSnapshotError &&
          typeof renderedSnapshotError.code === "string"
            ? renderedSnapshotError.code
            : "Unable to load game"}
        </p>
      ) : (
        <p className="px-4.5 text-fog">{"…"}</p>
      )}
    </main>
  );
}
