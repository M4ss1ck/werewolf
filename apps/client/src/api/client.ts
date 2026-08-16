import type {
  BotRosterEntry,
  ChatMessage,
  GameEvent,
  GameId,
  GameplayCommand,
  MeStats,
  PublicGameSummary,
  UserId,
  ViewerGameSnapshot,
} from "@werewolf/protocol";

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init.headers },
  });
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
  listGames: () => request<PublicGameSummary[]>("/api/games"),
  createGame: (input: CreateGameInput) =>
    request<PublicGameSummary>("/api/games", { ...json(input) }),
  getSnapshot: (id: GameId | string) => request<ViewerGameSnapshot>(`/api/games/${id}`),
  join: (id: GameId | string) => request<ViewerGameSnapshot>(`/api/games/${id}/join`, json({})),
  spectate: (id: GameId | string) =>
    request<ViewerGameSnapshot>(`/api/games/${id}/spectate`, json({})),
  leave: (id: GameId | string) =>
    request<ViewerGameSnapshot>(`/api/games/${id}/membership`, { method: "DELETE" }),
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
  sendChatMessage: (text: string) =>
    request<ChatMessage>("/api/chat/messages", { ...json({ text }) }),
  getChatHistory: (before: number) =>
    request<{ messages: ChatMessage[] }>(`/api/chat/messages?before=${before}`),
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
