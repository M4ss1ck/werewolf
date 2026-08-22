import { act, cleanup, renderHook } from "@testing-library/react";
import type { UserId } from "@werewolf/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ClientChatMessage, ConversationKey } from "./model.ts";
import {
  loadStoredReadState,
  mergeStoredReadState,
  pruneStoredReadState,
  saveStoredReadState,
  useChatReadStore,
} from "./read-store.ts";

const user = (value: string) => value as UserId;
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function row(id: number, authorId = "other"): ClientChatMessage {
  return {
    id,
    authorId: user(authorId),
    displayName: authorId,
    text: String(id),
    mentions: [],
    createdAt: id,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("read-state storage", () => {
  test("scopes records by exact user and conversation keys", () => {
    const db = storage();
    saveStoredReadState(db, user("alice"), "global", { readThrough: 4, seenAfter: [6] });
    expect(loadStoredReadState(db, user("alice"), "global")).toEqual({
      readThrough: 4,
      seenAfter: [6],
    });
    expect(loadStoredReadState(db, user("bob"), "global")).toBeUndefined();
  });

  test("rejects malformed records", () => {
    const db = storage();
    const key = "werewolf.chat-read.v1:alice:global";
    db.setItem(key, JSON.stringify({ version: 2, readThrough: 4, seenAfter: [], touchedAt: 1 }));
    expect(loadStoredReadState(db, user("alice"), "global")).toBeUndefined();
    db.setItem(key, JSON.stringify({ version: 1, readThrough: -1, seenAfter: [], touchedAt: 1 }));
    expect(loadStoredReadState(db, user("alice"), "global")).toBeUndefined();
    db.setItem(
      key,
      JSON.stringify({ version: 1, readThrough: 1, seenAfter: [2, Infinity], touchedAt: 1 }),
    );
    expect(loadStoredReadState(db, user("alice"), "global")).toBeUndefined();
  });

  test("merges storage monotonically without treating storage as visibility", () => {
    const db = storage();
    saveStoredReadState(db, user("alice"), "global", { readThrough: 3, seenAfter: [5] });
    expect(
      mergeStoredReadState(
        db,
        user("alice"),
        "global",
        { readThrough: 1, seenAfter: [] },
        [row(2), row(3), row(4), row(5)],
        user("alice"),
      ),
    ).toEqual({ readThrough: 3, seenAfter: [5] });
    db.removeItem("werewolf.chat-read.v1:alice:global");
    expect(loadStoredReadState(db, user("alice"), "global")).toBeUndefined();
  });

  test("retains global and deterministically prunes game records to 100", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const db = storage();
    saveStoredReadState(db, user("alice"), "global", { readThrough: 1, seenAfter: [] });
    for (let index = 0; index < 101; index += 1) {
      vi.setSystemTime(2_000 + index);
      saveStoredReadState(db, user("alice"), `game:g${index}:public` as ConversationKey, {
        readThrough: index,
        seenAfter: [],
      });
    }
    pruneStoredReadState(db, user("alice"));
    expect(loadStoredReadState(db, user("alice"), "global")).toBeDefined();
    expect(
      loadStoredReadState(db, user("alice"), "game:g0:public" as ConversationKey),
    ).toBeUndefined();
    expect(
      loadStoredReadState(db, user("alice"), "game:g100:public" as ConversationKey),
    ).toBeDefined();
  });

  test("does not inspect another user's prefix while loading", () => {
    const calls: string[] = [];
    const db = storage();
    const originalGet = db.getItem;
    db.getItem = (key) => {
      calls.push(key);
      return originalGet(key);
    };
    saveStoredReadState(db, user("alice"), "global", { readThrough: 2, seenAfter: [] });
    calls.length = 0;

    loadStoredReadState(db, user("alice"), "global");

    expect(
      calls.every((key) => key.includes(":alice:") || key === "werewolf.chat-read.v1:alice:index"),
    ).toBe(true);
    expect(calls.some((key) => key.includes(":bob:"))).toBe(false);
  });

  test("hook merges storage events monotonically and ignores external removal", () => {
    const key = "global" as ConversationKey;
    saveStoredReadState(localStorage, user("alice"), key, { readThrough: 1, seenAfter: [] });
    const { result } = renderHook(() => useChatReadStore(user("alice")));
    const externalKey = "werewolf.chat-read.v1:alice:global";
    const external = { version: 1, readThrough: 4, seenAfter: [6], touchedAt: 2 };

    act(() => {
      localStorage.setItem(externalKey, JSON.stringify(external));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: externalKey,
          newValue: JSON.stringify(external),
          storageArea: localStorage,
        }),
      );
    });
    expect(result.current.states[key]).toEqual({ readThrough: 4, seenAfter: [6] });

    act(() => {
      localStorage.removeItem(externalKey);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: externalKey,
          newValue: null,
          storageArea: localStorage,
        }),
      );
    });
    expect(result.current.states[key]).toEqual({ readThrough: 4, seenAfter: [6] });
  });

  test("hook marks visible rows and rebases retained rows", () => {
    const key = "global" as ConversationKey;
    saveStoredReadState(localStorage, user("alice"), key, { readThrough: 0, seenAfter: [] });
    const { result } = renderHook(() => useChatReadStore(user("alice")));
    const messages = [row(1), row(2), row(3)];

    act(() => result.current.markVisible(key, messages, [2]));
    expect(result.current.states[key]).toEqual({ readThrough: 0, seenAfter: [2] });
    act(() => result.current.markVisible(key, messages, [1]));
    expect(result.current.states[key]).toEqual({ readThrough: 2, seenAfter: [] });

    act(() => result.current.rebaseRetention(key, [row(10), row(11)], 10, 11));
    expect(result.current.states[key]).toEqual({ readThrough: 9, seenAfter: [] });
  });

  test("hook filters other users, is a null-user no-op, and cleans up its listener", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderHook(() => useChatReadStore(user("alice")));
    const otherKey = "werewolf.chat-read.v1:bob:global";
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: otherKey,
          newValue: JSON.stringify({ version: 1, readThrough: 8, seenAfter: [], touchedAt: 3 }),
          storageArea: localStorage,
        }),
      );
    });
    expect(result.current.states).toEqual({});
    unmount();
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));

    const nullHook = renderHook(() => useChatReadStore(null));
    act(() => {
      nullHook.result.current.establishBaseline("global", [row(1)]);
      nullHook.result.current.markThrough("global", 4);
    });
    expect(nullHook.result.current.states).toEqual({});
    expect(localStorage.length).toBe(0);
    nullHook.unmount();
  });

  test("ignores malformed index entries and malformed conversation event suffixes", () => {
    localStorage.setItem(
      "werewolf.chat-read.v1:alice:index",
      JSON.stringify({
        version: 1,
        conversations: {
          global: 1,
          "game:known:public": 2,
          "game::public": 3,
          "not-a-conversation": 4,
        },
      }),
    );
    localStorage.setItem(
      "werewolf.chat-read.v1:alice:game%3Aknown%3Apublic",
      JSON.stringify({ version: 1, readThrough: 2, seenAfter: [], touchedAt: 2 }),
    );
    localStorage.setItem(
      "werewolf.chat-read.v1:alice:game%3A%3Apublic",
      JSON.stringify({ version: 1, readThrough: 3, seenAfter: [], touchedAt: 3 }),
    );
    const { result } = renderHook(() => useChatReadStore(user("alice")));
    expect(result.current.states).toEqual({
      "game:known:public": { readThrough: 2, seenAfter: [] },
    });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "werewolf.chat-read.v1:alice:not-a-conversation",
          newValue: JSON.stringify({ version: 1, readThrough: 9, seenAfter: [], touchedAt: 9 }),
          storageArea: localStorage,
        }),
      );
    });
    expect(result.current.states).toEqual({
      "game:known:public": { readThrough: 2, seenAfter: [] },
    });
  });

  test("merges a stale in-memory update with the current record before writing", () => {
    const key = "global" as ConversationKey;
    saveStoredReadState(localStorage, user("alice"), key, { readThrough: 1, seenAfter: [] });
    const { result } = renderHook(() => useChatReadStore(user("alice")));
    const currentKey = "werewolf.chat-read.v1:alice:global";
    act(() => {
      localStorage.setItem(
        currentKey,
        JSON.stringify({ version: 1, readThrough: 9, seenAfter: [11], touchedAt: 3 }),
      );
      result.current.markThrough(key, 5);
    });
    expect(loadStoredReadState(localStorage, user("alice"), key)).toEqual({
      readThrough: 9,
      seenAfter: [11],
    });
  });

  test("establishing an existing baseline touches it without replacing its state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const key = "global" as ConversationKey;
    saveStoredReadState(localStorage, user("alice"), key, { readThrough: 3, seenAfter: [5] });
    const { result } = renderHook(() => useChatReadStore(user("alice")));
    vi.setSystemTime(2_000);

    act(() => result.current.establishBaseline(key, [row(10), row(11)]));

    expect(loadStoredReadState(localStorage, user("alice"), key)).toEqual({
      readThrough: 3,
      seenAfter: [5],
    });
    expect(
      JSON.parse(localStorage.getItem("werewolf.chat-read.v1:alice:index")!).conversations.global,
    ).toBe(2_000);
  });
});
