import type { ChatMention, UserId } from "@werewolf/protocol";
import { describe, expect, test } from "vitest";

import {
  applyChatEdit,
  canonicalizeDraft,
  diffChatText,
  filterMentionCandidates,
  findMentionQuery,
  isMentionQueryReady,
  renderMentionSegments,
  selectMention,
} from "./mentions.ts";

const user = (value: string) => value as UserId;
const mention = (userId: string, start: number, length: number): ChatMention => ({
  userId: user(userId),
  start,
  length,
});

describe("chat mention draft primitives", () => {
  test.each([
    ["hello", "heLlo", 2, 1, 1],
    ["hello", "hello!", 5, 0, 1],
    ["hello!", "hello", 5, 1, 0],
    ["a😀b", "aXb", 1, 2, 1],
    ["same", "same", 4, 0, 0],
  ])("diffs UTF-16 edits (%s -> %s)", (oldText, newText, start, removed, inserted) => {
    expect(diffChatText(oldText, newText)).toMatchObject({
      start,
      removedLength: removed,
      insertedLength: inserted,
    });
  });

  test("shifts and invalidates ranges at the specified boundaries", () => {
    const draft = {
      text: "abCD12ef",
      mentions: [mention("a", 0, 2), mention("b", 4, 2), mention("c", 6, 2)],
    };
    expect(applyChatEdit(draft, "abCDX12ef").mentions).toEqual([
      mention("a", 0, 2),
      mention("b", 5, 2),
      mention("c", 7, 2),
    ]);
    expect(
      applyChatEdit({ text: "abCD12ef", mentions: [mention("x", 3, 2)] }, "abX12ef").mentions,
    ).toEqual([]);
    expect(
      applyChatEdit({ text: "abCD12ef", mentions: [mention("x", 0, 2)] }, "XabCD12ef").mentions,
    ).toEqual([mention("x", 1, 2)]);
    expect(applyChatEdit({ text: "old", mentions: [mention("x", 0, 3)] }, "new").mentions).toEqual(
      [],
    );
    expect(applyChatEdit({ text: "@old", mentions: [mention("x", 0, 4)] }, "").mentions).toEqual(
      [],
    );
    expect(
      applyChatEdit({ text: "abCD12ef", mentions: [mention("x", 4, 2)] }, "abCD12ef!").mentions,
    ).toEqual([mention("x", 4, 2)]);
  });

  test("finds only an active legal query and never creates metadata from visible text", () => {
    expect(findMentionQuery("say @Moon W", 11)).toMatchObject({ start: 4, query: "Moon W" });
    expect(
      filterMentionCandidates(
        [{ userId: user("moon"), displayName: "Moon Walker" }],
        "Moon thanks",
      ),
    ).toEqual([]);
    expect(findMentionQuery("say @Moon,", 10)).toBeNull();
    expect(findMentionQuery("say @Moon @W", 12)).toMatchObject({ start: 10, query: "W" });
    expect(findMentionQuery("say @Moon", 3)).toBeNull();
    expect(findMentionQuery("say @Moon", 9, { escaped: true })).toBeNull();
    expect(findMentionQuery(`@${"a".repeat(24)}`, 25)).not.toBeNull();
    expect(findMentionQuery(`@${"a".repeat(25)}`, 26)).toBeNull();
    const legalQuery = "@Élan 42-foo_bar";
    expect(findMentionQuery(legalQuery, legalQuery.length)).toMatchObject({
      query: "Élan 42-foo_bar",
    });
    expect(applyChatEdit({ text: "", mentions: [] }, "@Moon")).toEqual({
      text: "@Moon",
      mentions: [],
    });
  });

  test("ranks prefix candidates, excludes self, and caps distinct recipients", () => {
    const candidates = [
      { userId: user("z"), displayName: "Ánna" },
      { userId: user("a"), displayName: "Anna" },
      { userId: user("b"), displayName: "Annabel" },
      { userId: user("self"), displayName: "Anna" },
    ];
    expect(
      filterMentionCandidates(candidates, "anna", {
        viewerId: user("self"),
        recentUserIds: [user("z")],
      }).map((row) => row.userId),
    ).toEqual([user("z"), user("a"), user("b")]);
    const selected = Array.from({ length: 8 }, (_, index) => mention(`u${index}`, index * 2, 1));
    expect(
      filterMentionCandidates([{ userId: user("ninth"), displayName: "Nine" }], "n", {
        selectedMentions: selected,
      }),
    ).toEqual([]);
    expect(
      filterMentionCandidates([{ userId: user("u0"), displayName: "One" }], "o", {
        selectedMentions: selected,
      }),
    ).toHaveLength(1);
  });

  test("keeps multiword prefixes active and applies ranking layers independently", () => {
    const multiword = [
      { userId: user("walker"), displayName: "Moon Walker" },
      { userId: user("word"), displayName: "Moon Word" },
    ];
    expect(
      filterMentionCandidates(multiword, "Moon ").map((candidate) => candidate.userId),
    ).toEqual([user("walker"), user("word")]);
    expect(filterMentionCandidates(multiword, "Moon W")).toHaveLength(2);
    expect(filterMentionCandidates(multiword, "Moon thanks")).toEqual([]);

    expect(
      filterMentionCandidates(
        [
          { userId: user("lower"), displayName: "moon" },
          { userId: user("exact"), displayName: "Moon" },
        ],
        "Moon",
      )[0]?.userId,
    ).toBe(user("exact"));
    expect(
      filterMentionCandidates(
        [
          { userId: user("normal"), displayName: "Ámbar" },
          { userId: user("other"), displayName: "Amora" },
        ],
        "am",
      ).map((candidate) => candidate.userId),
    ).toEqual([user("normal"), user("other")]);
    expect(
      filterMentionCandidates(
        [
          { userId: user("z"), displayName: "Am" },
          { userId: user("a"), displayName: "Am" },
        ],
        "am",
        { recentUserIds: [user("z")] },
      ).map((candidate) => candidate.userId),
    ).toEqual([user("z"), user("a")]);
    expect(
      filterMentionCandidates(
        [
          { userId: user("z"), displayName: "Am" },
          { userId: user("a"), displayName: "Am" },
        ],
        "am",
      ).map((candidate) => candidate.userId),
    ).toEqual([user("a"), user("z")]);
  });

  test("uses code-point readiness floors for local and global lookup", () => {
    expect(isMentionQueryReady("", "game")).toBe(false);
    expect(isMentionQueryReady("😀", "game")).toBe(true);
    expect(isMentionQueryReady("😀😀", "global")).toBe(false);
    expect(isMentionQueryReady("😀á", "global")).toBe(true);
    expect(
      filterMentionCandidates([{ userId: user("u"), displayName: "Moon" }], "", { scope: "game" }),
    ).toEqual([]);
    expect(
      filterMentionCandidates([{ userId: user("u"), displayName: "Moon" }], "mo", {
        scope: "global",
      }),
    ).toEqual([]);
  });

  test("selection inserts full name, keeps trailing space out of the range, and canonicalizes trim", () => {
    const draft = { text: "hi @Mo", mentions: [] };
    const query = findMentionQuery(draft.text, draft.text.length);
    expect(query).not.toBeNull();
    const selected = selectMention(draft, query!, {
      userId: user("moon"),
      displayName: "Moon Walker",
    });
    expect(selected).toEqual({ text: "hi @Moon Walker ", mentions: [mention("moon", 3, 12)] });
    expect(canonicalizeDraft({ text: "  hi @Moon ", mentions: [mention("moon", 5, 5)] })).toEqual({
      text: "hi @Moon",
      mentions: [mention("moon", 3, 5)],
    });
    expect(canonicalizeDraft({ text: " 😀 @Moon ", mentions: [mention("moon", 4, 5)] })).toEqual({
      text: "😀 @Moon",
      mentions: [mention("moon", 3, 5)],
    });
    expect(
      canonicalizeDraft({ text: "  @Moon", mentions: [mention("moon", 1, 5)] }),
    ).toBeUndefined();
  });

  test("renders only valid structured ranges and fails closed on malformed overlap", () => {
    expect(
      renderMentionSegments("hi @A and @B", [mention("a", 3, 2), mention("b", 10, 2)]),
    ).toEqual([
      { kind: "plain", text: "hi " },
      { kind: "mention", text: "@A", userId: user("a") },
      { kind: "plain", text: " and " },
      { kind: "mention", text: "@B", userId: user("b") },
    ]);
    expect(renderMentionSegments("hello", [mention("a", 0, 3), mention("b", 2, 2)])).toEqual([
      { kind: "plain", text: "hello" },
    ]);
    expect(renderMentionSegments("hello", [mention("a", 99, 1)])).toEqual([
      { kind: "plain", text: "hello" },
    ]);
    expect(
      renderMentionSegments("hello", [null, undefined, "not-a-range"] as unknown as ChatMention[]),
    ).toEqual([{ kind: "plain", text: "hello" }]);
  });
});
