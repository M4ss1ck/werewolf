import type { ChatContent, ChatMention, UserId } from "@werewolf/protocol";
import { CHAT_MAX_TEXT_LENGTH, normalizeMentionSearch } from "@werewolf/protocol";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Avatar } from "../components.tsx";
import { allocateIdentityMarks, type IdentityMark, IdentitySigil } from "./identity.tsx";
import {
  applyChatEdit,
  canonicalizeDraft,
  filterMentionCandidates,
  findMentionQuery,
  type MentionCandidate,
  renderMentionSegments,
  selectMention,
} from "./mentions.ts";
import type { ChatDraft, ClientChatMessage } from "./model.ts";

export type MentionCandidateSource =
  | { kind: "local"; candidates: MentionCandidate[] }
  | {
      kind: "remote";
      search(query: string, signal: AbortSignal): Promise<MentionCandidate[]>;
      recentUserIds: UserId[];
      refreshToken: number;
    };

export type ChatComposerProps = {
  inputId: string;
  label: string;
  placeholder: string;
  sendLabel: string;
  className?: string;
  draft: ChatDraft;
  source: MentionCandidateSource;
  readOnly: boolean;
  onDraftChange(draft: ChatDraft): void;
  onSend(content: ChatContent): Promise<void>;
  onSent(): void;
  onError?(error: unknown): void;
  onInvalidMention?(): void;
};

function queryFor(text: string, caret: number) {
  const match = findMentionQuery(text, caret);
  return match && match.query.length > 0 ? match : undefined;
}

function candidateKey(candidate: MentionCandidate): string {
  return candidate.userId;
}

export function ChatComposer({
  inputId,
  label,
  placeholder,
  sendLabel,
  className = "",
  draft,
  source,
  readOnly,
  onDraftChange,
  onSend,
  onSent,
  onError,
  onInvalidMention,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef(draft.text.length);
  const [query, setQuery] = useState(() => queryFor(draft.text, caretRef.current));
  const [options, setOptions] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [announce, setAnnounce] = useState("");
  const [sending, setSending] = useState(false);
  const suppressKeyUpRef = useRef<string | undefined>(undefined);
  const selectionHandledRef = useRef<string | undefined>(undefined);
  const selectionResetTimerRef = useRef<number | undefined>(undefined);
  const requestRef = useRef(0);
  const successfulRef = useRef<{ query: string; results: MentionCandidate[] } | undefined>(
    undefined,
  );
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const selectedMentions = draft.mentions;
  const updateQuery = () => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.text.length;
    caretRef.current = caret;
    setQuery(queryFor(draft.text, caret));
  };

  useEffect(() => {
    if (source.kind === "local") {
      requestRef.current += 1;
      successfulRef.current = undefined;
      setLoading(false);
      if (!query) {
        setOptions([]);
        setActiveIndex(-1);
        setAnnounce("");
        return;
      }
      const next = filterMentionCandidates(source.candidates, query.query, {
        selectedMentions,
        scope: "game",
      });
      setOptions(next);
      if (next.length === 0) {
        setQuery(undefined);
        setActiveIndex(-1);
        setAnnounce("");
      } else {
        setActiveIndex(0);
        setAnnounce(`${next.length} results`);
      }
      return;
    }

    const normalized = query ? normalizeMentionSearch(query.query.trim()) : "";
    if (!query || Array.from(query.query.trim()).length < 3) {
      requestRef.current += 1;
      setOptions([]);
      setLoading(false);
      setActiveIndex(-1);
      setAnnounce("");
      return;
    }
    if (successfulRef.current?.query !== normalized) {
      setOptions([]);
      setActiveIndex(-1);
      setLoading(false);
    }
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setAnnounce(t("ui.mentionSearchLoading"));
      void source
        .search(query.query, controller.signal)
        .then((candidates) => {
          if (!active || requestId !== requestRef.current) return;
          const next = filterMentionCandidates(candidates, query.query, {
            selectedMentions,
            recentUserIds: source.recentUserIds,
            scope: "global",
          });
          successfulRef.current = { query: normalized, results: next };
          setOptions(next);
          setActiveIndex(next.length > 0 ? 0 : -1);
          setLoading(false);
          setAnnounce(next.length > 0 ? `${next.length} results` : t("ui.mentionSearchEmpty"));
        })
        .catch(() => {
          if (!active || requestId !== requestRef.current || controller.signal.aborted) return;
          const previous = successfulRef.current;
          if (previous?.query === normalized) {
            setOptions(previous.results);
            setActiveIndex(previous.results.length > 0 ? 0 : -1);
          } else {
            setOptions([]);
            setActiveIndex(-1);
          }
          setLoading(false);
          setAnnounce("");
        });
    }, 200);
    return () => {
      active = false;
      requestRef.current += 1;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, source, selectedMentions, t]);

  const choose = (candidate: MentionCandidate) => {
    if (!query) return;
    const selectionKey = `${query.start}:${query.end}:${candidate.userId}`;
    if (selectionHandledRef.current === selectionKey) return;
    selectionHandledRef.current = selectionKey;
    const next = selectMention(draft, query, candidate);
    const caret = query.start + candidate.displayName.length + 2;
    onDraftChange(next);
    caretRef.current = caret;
    setQuery(undefined);
    setOptions([]);
    setActiveIndex(-1);
    if (selectionResetTimerRef.current !== undefined) {
      window.clearTimeout(selectionResetTimerRef.current);
    }
    selectionResetTimerRef.current = window.setTimeout(() => {
      selectionHandledRef.current = undefined;
      selectionResetTimerRef.current = undefined;
    }, 300);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  };

  useEffect(
    () => () => {
      if (selectionResetTimerRef.current !== undefined) {
        window.clearTimeout(selectionResetTimerRef.current);
      }
    },
    [],
  );

  const canonical = canonicalizeDraft(draft);
  const overLimit = draft.text.length > CHAT_MAX_TEXT_LENGTH;
  const submitDisabled = readOnly || canonical === undefined || overLimit || sending;
  const listOpen = query !== undefined && (options.length > 0 || loading);
  const optionIdentityMarks = allocateIdentityMarks(options);

  return (
    <form
      className={`chat-composer ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (submitDisabled || sending) return;
        if (!canonical) return;
        setSending(true);
        void Promise.resolve()
          .then(() => onSend(canonical))
          .then(() => {
            onDraftChange({ text: "", mentions: [] });
            onSent();
          })
          .catch((sendError: unknown) => {
            onError?.(sendError);
            if ((sendError as { code?: unknown })?.code === "INVALID_MENTION") {
              onInvalidMention?.();
            }
          })
          .finally(() => setSending(false));
      }}
    >
      <div className="chat-composer__field">
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        <input
          aria-activedescendant={listOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={listOpen}
          aria-label={label}
          className="chat-composer__input"
          disabled={readOnly}
          id={inputId}
          onChange={(event) => {
            suppressKeyUpRef.current = undefined;
            selectionHandledRef.current = undefined;
            const input = event.currentTarget;
            caretRef.current = input.selectionStart ?? input.value.length;
            onDraftChange(applyChatEdit(draft, input.value));
            const nextQuery = queryFor(input.value, caretRef.current);
            setQuery(nextQuery);
            if (!nextQuery) {
              setOptions([]);
              setActiveIndex(-1);
              setAnnounce("");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              suppressKeyUpRef.current = event.key;
              if (query !== undefined) requestRef.current += 1;
              setQuery(undefined);
              setOptions([]);
              setActiveIndex(-1);
              setAnnounce("");
              return;
            }
            if (!listOpen) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex((current) => (current + delta + options.length) % options.length);
            } else if (event.key === "Enter" || event.key === "Tab") {
              if (activeIndex >= 0) {
                event.preventDefault();
                suppressKeyUpRef.current = event.key;
                choose(options[activeIndex]!);
              }
            }
          }}
          onKeyUp={(event) => {
            if (suppressKeyUpRef.current === event.key) {
              suppressKeyUpRef.current = undefined;
              return;
            }
            updateQuery();
          }}
          onSelect={updateQuery}
          placeholder={placeholder}
          role="combobox"
          ref={inputRef}
          value={draft.text}
        />
        <div aria-live="polite" className="sr-only">
          {loading ? t("ui.mentionSearchLoading") : announce}
        </div>
        {listOpen && (
          <div className="chat-composer__options">
            {loading && (
              <div className="chat-composer__loading" role="status">
                {t("ui.mentionSearchLoading")}
              </div>
            )}
            <div id={listId} role="listbox">
              {options.map((candidate, index) => (
                <button
                  aria-label={`${candidate.displayName}, user ${candidate.userId}`}
                  aria-selected={activeIndex === index}
                  className={`chat-composer__option${activeIndex === index ? " chat-composer__option--active" : ""}`}
                  id={optionId(index)}
                  key={candidateKey(candidate)}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    choose(candidate);
                  }}
                  onTouchStart={(event) => {
                    event.preventDefault();
                    choose(candidate);
                  }}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  <IdentitySigil
                    aria-hidden="true"
                    className="chat-identity-mark"
                    mark={optionIdentityMarks.get(candidate.userId)!}
                  />
                  <span>{candidate.displayName}</span>
                  <span className="sr-only">, user {candidate.userId}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <button
        aria-label={sendLabel}
        className="chat-composer__send"
        disabled={submitDisabled}
        type="submit"
      >
        ↑
      </button>
    </form>
  );
}

export type ChatBubbleProps = {
  author: string;
  authorId?: UserId;
  text: string;
  mentions?: readonly ChatMention[];
  mine: boolean;
  viewerId?: UserId;
  message?: ClientChatMessage;
  identityMarks?: ReadonlyMap<string, IdentityMark>;
};

export function hasValidatedViewerMention(
  text: string,
  mentions: readonly ChatMention[],
  viewerId: UserId,
): boolean {
  return renderMentionSegments(text, mentions).some(
    (segment) => segment.kind === "mention" && segment.userId === viewerId,
  );
}

export function ChatBubble({
  author,
  authorId,
  text,
  mentions = [],
  mine,
  viewerId,
  identityMarks,
}: ChatBubbleProps) {
  const { t } = useTranslation();
  const segments = renderMentionSegments(text, mentions);
  const authorMark = authorId
    ? (identityMarks?.get(authorId) ??
      allocateIdentityMarks([{ userId: authorId, displayName: author }]).get(authorId))
    : undefined;
  const viewerMentioned =
    viewerId !== undefined &&
    segments.some((segment) => segment.kind === "mention" && segment.userId === viewerId);
  let segmentOffset = 0;
  return (
    <div className={`chat-bubble-row ${mine ? "justify-end" : ""}`}>
      {!mine &&
        (authorMark ? (
          <span
            className="chat-identity-mark"
            style={{ "--identity-color": authorMark.color } as CSSProperties}
          >
            <IdentitySigil mark={authorMark} />
          </span>
        ) : (
          <Avatar name={author} size="sm" />
        ))}
      <div className={`chat-bubble-author ${mine ? "items-end" : ""}`}>
        {!mine && <span className="chat-bubble-name">{author}</span>}
        <div
          className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"}${viewerMentioned ? " bubble--mentioned" : ""}`}
        >
          {viewerMentioned && <span className="sr-only">{t("ui.mentionedYou")}</span>}
          {segments.map((segment) => {
            const key = `${segment.kind}:${segmentOffset}:${segment.text}:${segment.kind === "mention" ? segment.userId : ""}`;
            segmentOffset += segment.text.length;
            if (segment.kind === "plain") return <span key={key}>{segment.text}</span>;
            const targetMark =
              identityMarks?.get(segment.userId) ??
              allocateIdentityMarks([{ userId: segment.userId, displayName: segment.text }]).get(
                segment.userId,
              );
            return (
              <span
                className="chat-mention"
                data-mention="true"
                key={key}
                style={
                  targetMark
                    ? ({ "--identity-color": targetMark.color } as CSSProperties)
                    : undefined
                }
              >
                {segment.text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
