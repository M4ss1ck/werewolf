import type { ChatMention, UserId } from "@werewolf/protocol";
import { normalizeChatContent, normalizeMentionSearch } from "@werewolf/protocol";

export type ChatDraft = {
  text: string;
  mentions: ChatMention[];
};

export type ChatTextDiff = {
  start: number;
  removedLength: number;
  insertedLength: number;
  oldEnd: number;
  newEnd: number;
};

export type MentionQuery = {
  start: number;
  end: number;
  query: string;
};

export type MentionCandidate = {
  userId: UserId;
  displayName: string;
  status?: string;
  isBot?: boolean;
};

export type MentionFilterOptions = {
  viewerId?: UserId;
  recentUserIds?: readonly UserId[];
  selectedMentions?: readonly ChatMention[];
  scope?: "game" | "global";
};

export type MentionSegment =
  | { kind: "plain"; text: string }
  | { kind: "mention"; text: string; userId: UserId };

export function diffChatText(oldText: string, newText: string): ChatTextDiff {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start += 1;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return {
    start,
    removedLength: oldEnd - start,
    insertedLength: newEnd - start,
    oldEnd,
    newEnd,
  };
}

function transformMentions(mentions: readonly ChatMention[], diff: ChatTextDiff): ChatMention[] {
  const removedEnd = diff.oldEnd;
  const delta = diff.insertedLength - diff.removedLength;
  const transformed: ChatMention[] = [];

  for (const mention of mentions) {
    const end = mention.start + mention.length;
    if (end <= diff.start) {
      transformed.push({ ...mention });
      continue;
    }

    // An insertion beginning at a mention's start is before that mention, but
    // replacement/deletion at that start removes part of its visible token.
    if (mention.start === diff.start && diff.removedLength === 0) {
      transformed.push({ ...mention, start: mention.start + delta });
      continue;
    }
    if (mention.start >= removedEnd) {
      transformed.push({ ...mention, start: mention.start + delta });
      continue;
    }

    // An insertion at the exact end is outside the mention. For a replacement
    // this also preserves a range whose end is the replacement start.
    if (diff.removedLength === 0 && diff.start === end) {
      transformed.push({ ...mention });
    }

    // Any other intersection means the user edited the visible mention token.
  }

  return transformed.sort(compareMentions);
}

export function applyChatEdit(draft: ChatDraft, newText: string): ChatDraft;
export function applyChatEdit(
  oldText: string,
  newText: string,
  mentions: readonly ChatMention[],
): ChatDraft;
export function applyChatEdit(
  draftOrOldText: ChatDraft | string,
  newText: string,
  mentions?: readonly ChatMention[],
): ChatDraft {
  const draft =
    typeof draftOrOldText === "string"
      ? { text: draftOrOldText, mentions: mentions ?? [] }
      : draftOrOldText;
  return {
    text: newText,
    mentions: transformMentions(draft.mentions, diffChatText(draft.text, newText)),
  };
}

function isQueryCharacter(character: string): boolean {
  return /[\p{L}\p{N} _-]/u.test(character);
}

export type FindMentionQueryOptions = { escaped?: boolean };

export function findMentionQuery(
  text: string,
  caret: number,
  options: FindMentionQueryOptions = {},
): MentionQuery | null {
  if (options.escaped || !Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  const at = text.lastIndexOf("@", caret - 1);
  if (at < 0) return null;
  const query = text.slice(at + 1, caret);
  if (query.length > 24 || query.includes("@")) return null;

  for (const character of query) {
    if (!isQueryCharacter(character)) return null;
  }

  return { start: at, end: caret, query };
}

function compareMentions(left: ChatMention, right: ChatMention): number {
  return (
    left.start - right.start ||
    left.length - right.length ||
    (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)
  );
}

function recentRank(userId: UserId, recentUserIds: readonly UserId[]): number {
  const index = recentUserIds.indexOf(userId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  options: MentionFilterOptions = {},
): MentionCandidate[] {
  const normalizedQuery = normalizeMentionSearch(query.trim());
  if (options.scope !== undefined && !isMentionQueryReady(query, options.scope)) return [];
  const selectedIds = new Set(options.selectedMentions?.map((mention) => mention.userId));
  const selectedCount = selectedIds.size;
  const seen = new Set<UserId>();
  const matching: MentionCandidate[] = [];

  for (const candidate of candidates) {
    if (options.viewerId !== undefined && candidate.userId === options.viewerId) continue;
    if (seen.has(candidate.userId)) continue;
    if (!normalizeMentionSearch(candidate.displayName).startsWith(normalizedQuery)) continue;
    if (selectedCount >= 8 && !selectedIds.has(candidate.userId)) continue;
    seen.add(candidate.userId);
    matching.push(candidate);
  }

  matching.sort((left, right) => {
    const exactCase =
      Number(right.displayName.startsWith(query.trim())) -
      Number(left.displayName.startsWith(query.trim()));
    return (
      exactCase ||
      recentRank(left.userId, options.recentUserIds ?? []) -
        recentRank(right.userId, options.recentUserIds ?? []) ||
      compareStrings(
        normalizeMentionSearch(left.displayName),
        normalizeMentionSearch(right.displayName),
      ) ||
      compareStrings(left.userId, right.userId)
    );
  });
  return matching.slice(0, 8);
}

/** Global lookup counts Unicode code points; game lookup needs one code point. */
export function isMentionQueryReady(query: string, scope: "game" | "global"): boolean {
  const trimmed = query.trim();
  return Array.from(trimmed).length >= (scope === "global" ? 3 : 1);
}

export function selectMention(
  draft: ChatDraft,
  query: MentionQuery,
  candidate: MentionCandidate,
): ChatDraft {
  const replacement = `@${candidate.displayName} `;
  const nextText = draft.text.slice(0, query.start) + replacement + draft.text.slice(query.end);
  const edited = applyChatEdit(draft, nextText);
  const selectedRange: ChatMention = {
    userId: candidate.userId,
    start: query.start,
    length: replacement.length - 1,
  };
  return {
    text: edited.text,
    mentions: [...edited.mentions, selectedRange].sort(compareMentions),
  };
}

export function canonicalizeDraft(draft: ChatDraft): ChatDraft | undefined {
  const canonical = normalizeChatContent({ text: draft.text, mentions: draft.mentions });
  return canonical === undefined
    ? undefined
    : { text: canonical.text, mentions: canonical.mentions };
}

function validMentionRanges(text: string, mentions: readonly ChatMention[]): ChatMention[] | null {
  if (!Array.isArray(mentions)) return null;
  const rawMentions = mentions as readonly unknown[];
  for (const rawMention of rawMentions) {
    if (typeof rawMention !== "object" || rawMention === null || Array.isArray(rawMention)) {
      return null;
    }
  }
  const sorted = [...(rawMentions as readonly ChatMention[])].sort(compareMentions);
  for (const mention of sorted) {
    if (
      typeof mention.userId !== "string" ||
      mention.userId.length === 0 ||
      !Number.isInteger(mention.start) ||
      mention.start < 0 ||
      !Number.isInteger(mention.length) ||
      mention.length <= 0 ||
      mention.start + mention.length > text.length
    ) {
      return null;
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.start < previous.start + previous.length) return null;
  }
  return sorted;
}

export function renderMentionSegments(
  text: string,
  mentions: readonly ChatMention[],
): MentionSegment[] {
  const sorted = validMentionRanges(text, mentions);
  if (sorted === null) return [{ kind: "plain", text }];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const mention of sorted) {
    if (mention.start > cursor)
      segments.push({ kind: "plain", text: text.slice(cursor, mention.start) });
    segments.push({
      kind: "mention",
      text: text.slice(mention.start, mention.start + mention.length),
      userId: mention.userId,
    });
    cursor = mention.start + mention.length;
  }
  if (cursor < text.length) segments.push({ kind: "plain", text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "plain", text }];
}
