import type { ChatChannel, ChatContent, ChatMention, UserId } from "@werewolf/protocol";
import type { BotDecision, BotDecisionInput } from "./types.ts";

/** Truncate by UTF-16 code units without leaving a surrogate half behind. */
export function truncateUtf16(value: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (value.length <= maxUnits) return value;
  let end = maxUnits;
  const boundary = value.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function candidateFor(
  input: BotDecisionInput,
  id: number,
  channel: ChatChannel | null,
): BotDecisionInput["mentionCandidates"][number] | undefined {
  const candidate = input.mentionCandidates.find((entry) => entry.id === id);
  if (
    !candidate ||
    channel === null ||
    !input.speakableChannels.includes(channel) ||
    !candidate.channels.includes(channel)
  )
    return undefined;
  return candidate;
}

/** The sole builder for structured bot chat prefixes and their ranges. */
export function composeBotChatContent(
  decision: BotDecision,
  input: BotDecisionInput,
  currentTargetIds: ReadonlySet<UserId>,
): ChatContent | null {
  const channel = decision.channel;
  const selected: BotDecisionInput["mentionCandidates"] = [];
  const seen = new Set<UserId>();
  for (const id of decision.mentionIds) {
    const candidate = candidateFor(input, id, channel);
    if (!candidate || !currentTargetIds.has(candidate.userId) || seen.has(candidate.userId))
      continue;
    seen.add(candidate.userId);
    selected.push(candidate);
    if (selected.length === 8) break;
  }

  const speech = decision.say?.trim() ? truncateUtf16(decision.say.trim(), 300) : "";
  // Remove recipients from the end until the prefix itself (and its separator
  // when speech remains) can fit. A token is always retained whole.
  while (selected.length > 0) {
    const prefix = selected.map((candidate) => `@${candidate.displayName}`).join(" ");
    const required = prefix.length + (speech.length > 0 ? 1 : 0);
    if (required <= 500) break;
    selected.pop();
  }

  const prefix = selected.map((candidate) => `@${candidate.displayName}`).join(" ");
  const speechBudget = Math.max(
    0,
    500 - prefix.length - (prefix.length > 0 && speech.length > 0 ? 1 : 0),
  );
  const remainingSpeech = truncateUtf16(speech, speechBudget);
  if (prefix.length === 0 && remainingSpeech.length === 0) return null;

  const text =
    prefix.length > 0
      ? remainingSpeech.length > 0
        ? `${prefix} ${remainingSpeech}`
        : prefix
      : remainingSpeech;
  const mentions: ChatMention[] = [];
  let start = 0;
  for (const candidate of selected) {
    const token = `@${candidate.displayName}`;
    mentions.push({ userId: candidate.userId, start, length: token.length });
    start += token.length + 1;
  }
  return { text, mentions };
}
