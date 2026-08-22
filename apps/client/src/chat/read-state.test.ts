import type { UserId } from "@werewolf/protocol";
import { describe, expect, test } from "vitest";

import type { ClientChatMessage } from "./model.ts";
import {
  baselineReadState,
  markThrough,
  markVisible,
  mergeReadState,
  rebaseRetainedState,
  unreadSummary,
} from "./read-state.ts";

const user = (value: string) => value as UserId;

function message(id: number, authorId = "other", mentions: string[] = []): ClientChatMessage {
  return {
    id,
    authorId: user(authorId),
    displayName: authorId,
    text: `message ${id}`,
    mentions: mentions.map((targetId) => ({ userId: user(targetId), start: 0, length: 1 })),
    createdAt: id,
  };
}

const viewer = user("viewer");

describe("read state", () => {
  test("baselines at the latest known row, including own rows", () => {
    expect(baselineReadState([message(2), message(7, "viewer"), message(4)])).toEqual({
      readThrough: 7,
      seenAfter: [],
    });
    expect(baselineReadState([])).toEqual({ readThrough: 0, seenAfter: [] });
  });

  test("marks another author unread while own rows stay excluded", () => {
    const state = { readThrough: 1, seenAfter: [] };
    expect(unreadSummary(state, [message(2), message(3, "viewer")], viewer)).toEqual({
      ids: [2],
      count: 1,
      mentioned: false,
    });
  });

  test("advances contiguous visibility, preserves holes, and collapses holes", () => {
    const rows = [message(1), message(2), message(3), message(4)];
    const state = { readThrough: 0, seenAfter: [] };
    const hole = markVisible(state, rows, viewer, [3]);
    expect(hole).toEqual({ readThrough: 0, seenAfter: [3] });
    const closed = markVisible(hole, rows, viewer, [1, 2]);
    expect(closed).toEqual({ readThrough: 3, seenAfter: [] });
    expect(markVisible(closed, rows, viewer, [4])).toEqual({ readThrough: 4, seenAfter: [] });
  });

  test("crosses own rows during collapse without making them intersections", () => {
    const rows = [message(1), message(2, "viewer"), message(3)];
    expect(markVisible({ readThrough: 0, seenAfter: [] }, rows, viewer, [1])).toEqual({
      readThrough: 2,
      seenAfter: [],
    });
  });

  test("markThrough clears holes through the latest id", () => {
    expect(markThrough({ readThrough: 3, seenAfter: [5, 7, 9] }, 7)).toEqual({
      readThrough: 7,
      seenAfter: [9],
    });
    expect(markThrough({ readThrough: 8, seenAfter: [9] }, 7)).toEqual({
      readThrough: 8,
      seenAfter: [9],
    });
  });

  test("structured recipients, not plain text, drive mention state", () => {
    const rows = [message(1, "other", ["viewer"]), message(2)];
    expect(unreadSummary({ readThrough: 0, seenAfter: [] }, rows, viewer).mentioned).toBe(true);
    expect(
      unreadSummary({ readThrough: 0, seenAfter: [] }, [{ ...message(1), text: "@viewer" }], viewer)
        .mentioned,
    ).toBe(false);
  });

  test("merges monotonically, unions holes, and collapses known rows", () => {
    const rows = [message(1), message(2), message(3), message(4)];
    expect(
      mergeReadState(
        { readThrough: 1, seenAfter: [4] },
        { readThrough: 2, seenAfter: [3] },
        rows,
        viewer,
      ),
    ).toEqual({ readThrough: 4, seenAfter: [] });
    expect(
      mergeReadState(
        { readThrough: 3, seenAfter: [] },
        { readThrough: 1, seenAfter: [] },
        rows,
        viewer,
      ),
    ).toEqual({ readThrough: 3, seenAfter: [] });
  });

  test("rebases expired retention at the available boundary", () => {
    const rows = [message(10), message(11), message(12)];
    expect(rebaseRetainedState({ readThrough: 2, seenAfter: [4] }, rows, viewer, 10, 12)).toEqual({
      readThrough: 9,
      seenAfter: [],
    });
    const retainedOther = [message(10), message(11)];
    const rebased = rebaseRetainedState(
      { readThrough: 2, seenAfter: [] },
      retainedOther,
      viewer,
      10,
      11,
    );
    expect(unreadSummary(rebased, retainedOther, viewer).ids).toEqual([10, 11]);
    expect(
      rebaseRetainedState({ readThrough: 100, seenAfter: [101] }, rows, viewer, 10, 12),
    ).toEqual({
      readThrough: 12,
      seenAfter: [],
    });
    expect(rebaseRetainedState({ readThrough: 2, seenAfter: [4] }, [], viewer, 0, 0)).toEqual({
      readThrough: 0,
      seenAfter: [],
    });
  });
});
