import type { UserId } from "@werewolf/protocol";
import { CHAT_CHANNELS } from "@werewolf/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientChatMessage, ConversationKey } from "./model.ts";
import {
  markThrough as advanceThrough,
  markVisible as advanceVisible,
  baselineReadState,
  type ConversationReadState,
  mergeReadState,
  rebaseRetainedState as rebaseState,
} from "./read-state.ts";

const STORAGE_PREFIX = "werewolf.chat-read.v1:";
const MAX_GAME_RECORDS = 100;

type StoredReadRecord = {
  version: 1;
  readThrough: number;
  seenAfter: number[];
  touchedAt: number;
};

type StoredIndex = {
  version: 1;
  conversations: Partial<Record<ConversationKey, number>>;
};

function recordKey(userId: UserId, conversationKey: ConversationKey): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(conversationKey)}`;
}

function indexKey(userId: UserId): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}:index`;
}

function isConversationKey(value: string): value is ConversationKey {
  if (value === "global") return true;
  const parts = value.split(":");
  return (
    parts.length === 3 &&
    parts[0] === "game" &&
    parts[1] !== "" &&
    CHAT_CHANNELS.includes(parts[2] as (typeof CHAT_CHANNELS)[number])
  );
}

function validId(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function parseReadRecord(raw: string | null): StoredReadRecord | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      !validId(record.readThrough) ||
      !Array.isArray(record.seenAfter) ||
      !validId(record.touchedAt) ||
      !record.seenAfter.every(validId)
    ) {
      return undefined;
    }
    const seenAfter = [...new Set(record.seenAfter as number[])].sort(
      (left, right) => left - right,
    );
    if (seenAfter.some((id) => id <= (record.readThrough as number))) return undefined;
    return {
      version: 1,
      readThrough: record.readThrough,
      seenAfter,
      touchedAt: record.touchedAt,
    };
  } catch {
    return undefined;
  }
}

function parseIndex(raw: string | null): StoredIndex | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.conversations !== "object" ||
      record.conversations === null
    ) {
      return undefined;
    }
    const conversations: Partial<Record<ConversationKey, number>> = {};
    for (const [key, touchedAt] of Object.entries(record.conversations)) {
      if (isConversationKey(key) && validId(touchedAt)) conversations[key] = touchedAt;
    }
    return { version: 1, conversations };
  } catch {
    return undefined;
  }
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // An unavailable storage adapter is treated as absent state.
  }
}

function emptyIndex(): StoredIndex {
  return { version: 1, conversations: {} };
}

export function pruneStoredReadState(storage: Storage, userId: UserId): void {
  const key = indexKey(userId);
  const index = parseIndex(safeGet(storage, key));
  if (index === undefined) return;
  const games = Object.entries(index.conversations)
    .filter(
      (entry): entry is [string, number] =>
        isConversationKey(entry[0]) && entry[0] !== "global" && validId(entry[1]),
    )
    .sort(
      ([leftKey, leftTouched], [rightKey, rightTouched]) =>
        leftTouched - rightTouched || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
    );
  while (games.length > MAX_GAME_RECORDS) {
    const [conversationKey] = games.shift()!;
    safeRemove(storage, recordKey(userId, conversationKey as ConversationKey));
    delete index.conversations[conversationKey as ConversationKey];
  }
  safeSet(storage, key, JSON.stringify(index));
}

export function loadStoredReadState(
  storage: Storage,
  userId: UserId,
  conversationKey: ConversationKey,
): ConversationReadState | undefined {
  if (!isConversationKey(conversationKey)) return undefined;
  pruneStoredReadState(storage, userId);
  const record = parseReadRecord(safeGet(storage, recordKey(userId, conversationKey)));
  if (record === undefined) return undefined;
  return { readThrough: record.readThrough, seenAfter: record.seenAfter };
}

export function saveStoredReadState(
  storage: Storage,
  userId: UserId,
  conversationKey: ConversationKey,
  state: ConversationReadState,
): void {
  if (!isConversationKey(conversationKey)) return;
  const existing = parseReadRecord(safeGet(storage, recordKey(userId, conversationKey)));
  const requestedReadThrough = validId(state.readThrough) ? state.readThrough : 0;
  const readThrough = Math.max(existing?.readThrough ?? 0, requestedReadThrough);
  const seenAfter = [...new Set(state.seenAfter)]
    .concat(existing?.seenAfter ?? [])
    .filter((id) => validId(id) && id > readThrough)
    .sort((left, right) => left - right);
  const touchedAt = Date.now();
  safeSet(
    storage,
    recordKey(userId, conversationKey),
    JSON.stringify({ version: 1, readThrough, seenAfter, touchedAt } satisfies StoredReadRecord),
  );
  const current = parseIndex(safeGet(storage, indexKey(userId))) ?? emptyIndex();
  current.conversations[conversationKey] = touchedAt;
  safeSet(storage, indexKey(userId), JSON.stringify(current));
  pruneStoredReadState(storage, userId);
}

export function mergeStoredReadState(
  storage: Storage,
  userId: UserId,
  conversationKey: ConversationKey,
  current: ConversationReadState,
  messages: readonly ClientChatMessage[],
  viewerId: UserId,
): ConversationReadState {
  const stored = loadStoredReadState(storage, userId, conversationKey);
  return stored === undefined ? current : mergeReadState(current, stored, messages, viewerId);
}

export type ChatReadStoreController = {
  states: Readonly<Partial<Record<ConversationKey, ConversationReadState>>>;
  hasRecord(key: ConversationKey): boolean;
  establishBaseline(key: ConversationKey, messages: readonly ClientChatMessage[]): void;
  markVisible(
    key: ConversationKey,
    messages: readonly ClientChatMessage[],
    ids: readonly number[],
  ): void;
  markThrough(key: ConversationKey, latestId: number): void;
  rebaseRetention(
    key: ConversationKey,
    messages: readonly ClientChatMessage[],
    oldestRetainedId: number,
    latestId: number,
  ): void;
};

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function loadAllStoredStates(
  storage: Storage,
  userId: UserId,
): Partial<Record<ConversationKey, ConversationReadState>> {
  const index = parseIndex(safeGet(storage, indexKey(userId)));
  if (index === undefined) return {};
  const states: Partial<Record<ConversationKey, ConversationReadState>> = {};
  for (const conversationKey of Object.keys(index.conversations) as ConversationKey[]) {
    const state = loadStoredReadState(storage, userId, conversationKey);
    if (state !== undefined) states[conversationKey] = state;
  }
  return states;
}

export function useChatReadStore(userId: UserId | null): ChatReadStoreController {
  const storage = browserStorage();
  const [states, setStates] = useState<Partial<Record<ConversationKey, ConversationReadState>>>({});
  const messagesRef = useRef<Partial<Record<ConversationKey, ClientChatMessage[]>>>({});
  const userRef = useRef<UserId | null>(userId);

  useEffect(() => {
    userRef.current = userId;
    messagesRef.current = {};
    if (storage === undefined || userId === null) {
      setStates({});
      return;
    }
    setStates(loadAllStoredStates(storage, userId));
  }, [storage, userId]);

  useEffect(() => {
    if (storage === undefined || userId === null || typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== null && event.storageArea !== storage) return;
      const ownRecordPrefix = `${STORAGE_PREFIX}${encodeURIComponent(userId)}:`;
      if (event.key !== null && !event.key.startsWith(ownRecordPrefix)) return;
      setStates((current) => {
        const next = { ...current };
        if (event.key === indexKey(userId)) {
          const loaded = loadAllStoredStates(storage, userId);
          for (const key of Object.keys(loaded)) {
            const conversationKey = key as ConversationKey;
            const state = loaded[conversationKey];
            if (state === undefined) continue;
            const knownMessages = messagesRef.current[conversationKey] ?? [];
            const previous = next[conversationKey];
            next[conversationKey] =
              previous === undefined
                ? state
                : mergeReadState(previous, state, knownMessages, userId);
          }
        } else if (event.key !== null && event.key.startsWith(ownRecordPrefix)) {
          const encodedKey = event.key.slice(ownRecordPrefix.length);
          let conversationKey: ConversationKey;
          try {
            conversationKey = decodeURIComponent(encodedKey) as ConversationKey;
          } catch {
            return next;
          }
          if (!isConversationKey(conversationKey)) return next;
          const external = parseReadRecord(event.newValue);
          if (external === undefined) return next;
          const state = { readThrough: external.readThrough, seenAfter: external.seenAfter };
          const knownMessages = messagesRef.current[conversationKey] ?? [];
          const previous = next[conversationKey];
          next[conversationKey] =
            previous === undefined ? state : mergeReadState(previous, state, knownMessages, userId);
        }
        return next;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storage, userId]);

  const update = useCallback(
    (
      key: ConversationKey,
      messages: readonly ClientChatMessage[],
      updater: (state: ConversationReadState) => ConversationReadState,
    ) => {
      const activeUser = userRef.current;
      if (activeUser === null || storage === undefined) return;
      messagesRef.current[key] = [...messages];
      setStates((current) => {
        const previous = current[key];
        const proposed = updater(previous ?? baselineReadState(messages));
        const nextState = mergeStoredReadState(
          storage,
          activeUser,
          key,
          proposed,
          messages,
          activeUser,
        );
        const next = { ...current, [key]: nextState };
        saveStoredReadState(storage, activeUser, key, nextState);
        return next;
      });
    },
    [storage],
  );

  const establishBaseline = useCallback(
    (key: ConversationKey, messages: readonly ClientChatMessage[]) => {
      const activeUser = userRef.current;
      if (activeUser === null || storage === undefined) return;
      messagesRef.current[key] = [...messages];
      setStates((current) => {
        const stored = loadStoredReadState(storage, activeUser, key);
        const existing = current[key] ?? stored;
        const proposed = existing ?? baselineReadState(messages);
        const state = mergeStoredReadState(
          storage,
          activeUser,
          key,
          proposed,
          existing === undefined ? messages : [],
          activeUser,
        );
        saveStoredReadState(storage, activeUser, key, state);
        return { ...current, [key]: state };
      });
    },
    [storage],
  );

  const markVisible = useCallback(
    (key: ConversationKey, messages: readonly ClientChatMessage[], ids: readonly number[]) =>
      update(key, messages, (state) =>
        advanceVisible(state, messages, userId ?? ("" as UserId), ids),
      ),
    [update, userId],
  );
  const markThrough = useCallback(
    (key: ConversationKey, latestId: number) =>
      update(key, messagesRef.current[key] ?? [], (state) => advanceThrough(state, latestId)),
    [update],
  );
  const rebaseRetention = useCallback(
    (
      key: ConversationKey,
      messages: readonly ClientChatMessage[],
      oldestRetainedId: number,
      latestId: number,
    ) =>
      update(key, messages, (state) =>
        rebaseState(state, messages, userId ?? ("" as UserId), oldestRetainedId, latestId),
      ),
    [update, userId],
  );

  return useMemo(
    () => ({
      states,
      hasRecord: (key: ConversationKey) => states[key] !== undefined,
      establishBaseline,
      markVisible,
      markThrough,
      rebaseRetention,
    }),
    [establishBaseline, markThrough, markVisible, rebaseRetention, states],
  );
}
