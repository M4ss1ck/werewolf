import type {
  BotRosterEntry,
  ChatContent,
  ChatMessage,
  GameEntryMode,
  GameEntryReference,
  GameEvent,
  GameId,
  GameplayCommand,
  GameSummary,
  MeStats,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";

import {
  ChatMessageSchema,
  GameAdmissionResultSchema,
  GameEntryPreviewSchema,
  GameIdSchema,
  GameSummarySchema,
  MentionCandidateSchema,
  OwnerGameInvitationSchema,
} from "@werewolf/protocol";

import { captureAuthToken, getAuthToken } from "../auth/token.ts";
import { apiUrl } from "./origin.ts";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ApiError";
    this.code = code;
  }
}

export interface CreateGameInput {
  name: string;
  visibility?: "public" | "private";
  scheduledAt?: number;
  settings?: {
    discussionDurationMs?: number;
    votingDurationMs?: number;
    nightDurationMs?: number;
    spectatingEnabled?: boolean;
  };
}

export interface CreateGameResult {
  gameId: GameId;
}

export type GameEntryReferenceInput =
  | GameEntryReference
  | { kind: "invitation"; code: string }
  | { kind: "public-game"; gameId: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  captureAuthToken(response);
  if (!response.ok) {
    let code = "UNKNOWN_ERROR";
    try {
      const body = (await response.json()) as { error?: { code?: string } };
      code = body.error?.code ?? code;
    } catch {
      // The UI still receives a stable, translatable code for malformed errors.
    }
    throw new ApiError(code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  listGames: (scope: "browse" | "mine" = "browse") =>
    request<unknown>(scope === "browse" ? "/api/games" : "/api/games?scope=mine").then(
      (body) => GameSummarySchema.array().parse(body) as GameSummary[],
    ),
  listBrowseGames: () => api.listGames("browse"),
  listMyGames: () => api.listGames("mine"),
  createGame: (input: CreateGameInput) =>
    request<unknown>("/api/games", { ...json(input) }).then((body) => {
      if (typeof body !== "object" || body === null) throw new ApiError("VALIDATION");
      const gameId = GameIdSchema.safeParse((body as { gameId?: unknown }).gameId);
      if (!gameId.success) throw new ApiError("VALIDATION");
      return { gameId: gameId.data };
    }),
  getSnapshot: (id: GameId | string) => request<ViewerGameSnapshot>(`/api/games/${id}`),
  previewGameEntry: (reference: GameEntryReferenceInput) => {
    const query =
      reference.kind === "invitation"
        ? `code=${encodeURIComponent(reference.code)}`
        : `gameId=${encodeURIComponent(reference.gameId)}`;
    return request<unknown>(`/api/game-entry?${query}`).then((body) =>
      GameEntryPreviewSchema.parse(body),
    );
  },
  admitGameEntry: (reference: GameEntryReferenceInput, mode: GameEntryMode) =>
    request<unknown>("/api/game-entry", {
      ...json({ reference, mode }),
    }).then((body) => GameAdmissionResultSchema.parse(body)),
  getInvitation: (id: GameId | string) =>
    request<unknown>(`/api/games/${id}/invitation`).then((body) =>
      OwnerGameInvitationSchema.parse(body),
    ),
  leave: (id: GameId | string) =>
    request<void>(`/api/games/${id}/membership`, { method: "DELETE" }),
  kick: (id: GameId | string, userId: UserId | string) =>
    request<ViewerGameSnapshot>(`/api/games/${id}/players/${userId}`, { method: "DELETE" }),
  start: (id: GameId | string) => request<ViewerGameSnapshot>(`/api/games/${id}/start`, json({})),
  listBots: (id: GameId | string) => request<BotRosterEntry[]>(`/api/games/${id}/bots`),
  addBot: (id: GameId | string, botId: string) =>
    request<ViewerGameSnapshot>(`/api/games/${id}/bots`, json({ botId })),
  cancel: (id: GameId | string) => request<ViewerGameSnapshot>(`/api/games/${id}/cancel`, json({})),
  patchGame: (id: GameId | string, input: { name?: string; visibility?: "public" | "private" }) =>
    request<ViewerGameSnapshot>(`/api/games/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  postCommand: (id: GameId | string, command: Omit<GameplayCommand, "commandId">) =>
    request<unknown>(`/api/games/${id}/commands`, {
      method: "POST",
      body: JSON.stringify({ ...command, commandId: crypto.randomUUID() }),
    }),
  getEvents: (id: GameId | string, cursor = 0) =>
    request<{ events: GameEvent[] }>(`/api/games/${id}/events?cursor=${cursor}`),
  getReplay: (id: GameId | string) =>
    request<{ snapshot: ViewerGameSnapshot; events: GameEvent[] }>(`/api/games/${id}/replay`),
  getStats: () => request<MeStats>("/api/me/stats"),
  sendChatMessage: (content: ChatContent) =>
    request<ChatMessage>("/api/chat/messages", {
      ...json({ text: content.text, mentions: content.mentions }),
    }).then((message) => ChatMessageSchema.parse(message)),
  getChatHistory: (before: number) =>
    request<{ messages: ChatMessage[] }>(`/api/chat/messages?before=${before}`).then((result) => ({
      messages: result.messages.map((message) => ChatMessageSchema.parse(message)),
    })),
  getMentionCandidates: (query: string, signal?: AbortSignal) =>
    request<unknown>(
      `/api/chat/mention-candidates?q=${encodeURIComponent(query)}`,
      signal === undefined ? {} : { signal },
    ).then((body) => MentionCandidateSchema.array().parse(body)),
  patchLocale: (locale: "en" | "es") =>
    request<{ locale: "en" | "es" }>("/api/me/locale", {
      method: "PATCH",
      body: JSON.stringify({ locale }),
    }),
  setUsername: (username: string) =>
    request<{ userId: string; username: string }>("/api/me/username", {
      method: "PATCH",
      body: JSON.stringify({ username }),
    }),
};

export type ApiClient = typeof api;
