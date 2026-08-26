import type { GameEntryMode, GameEntryPreview } from "@werewolf/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api, type GameEntryReferenceInput } from "../api/client.ts";
import { Chip, ErrorMessage } from "../components.tsx";
import { replace } from "../routes.tsx";

function destinationFor(gameId: string, destination: "game" | "replay") {
  return destination === "replay" ? `/games/${gameId}/replay` : `/games/${gameId}`;
}

function scheduledLabel(timestamp: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function GameEntryScreen({ reference }: { reference: GameEntryReferenceInput }) {
  const { t, i18n } = useTranslation();
  const [preview, setPreview] = useState<GameEntryPreview | null>(null);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState<GameEntryMode>();
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const admissionPendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPreview = useCallback(() => {
    const generation = ++requestGenerationRef.current;
    setPreview(null);
    setError(undefined);
    setPending(undefined);
    return api
      .previewGameEntry(reference)
      .then((next) => {
        if (!mountedRef.current || generation !== requestGenerationRef.current) return next;
        setPreview(next);
        if (next.membership !== null && next.gameId) {
          replace(destinationFor(next.gameId, next.membership === "replay" ? "replay" : "game"));
        }
        return next;
      })
      .catch((caught: unknown) => {
        if (!mountedRef.current || generation !== requestGenerationRef.current) return;
        setPreview(null);
        setError(caught);
      });
  }, [reference]);

  useEffect(() => {
    void loadPreview();
    return () => {
      requestGenerationRef.current += 1;
      admissionPendingRef.current = false;
    };
  }, [loadPreview]);

  const admit = async (mode: GameEntryMode) => {
    if (admissionPendingRef.current) return;
    admissionPendingRef.current = true;
    const generation = ++requestGenerationRef.current;
    setPending(mode);
    setError(undefined);
    try {
      const result = await api.admitGameEntry(reference, mode);
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      replace(destinationFor(result.gameId, result.destination));
    } catch (caught) {
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setPending(undefined);
      if (caught instanceof ApiError && caught.code === "CONFLICT") {
        await loadPreview();
        admissionPendingRef.current = false;
      } else {
        admissionPendingRef.current = false;
        setError(caught);
      }
    }
  };

  if (preview === null && error === undefined)
    return <p className="px-4.5 py-6 font-mono text-sm text-fog">{t("ui.entry.loading")}</p>;
  if (preview === null)
    return (
      <div className="flex flex-col gap-4 px-4.5 py-6">
        <ErrorMessage error={error} />
        <button className="btn btn--ghost" onClick={() => void loadPreview()} type="button">
          {t("ui.entry.tryAgain")}
        </button>
      </div>
    );

  const hasAction = preview.canJoin || preview.canSpectate || preview.canReplay;
  return (
    <div className="screen__scroll flex flex-col gap-5 px-4.5 pb-6 pt-6">
      <header className="flex flex-col gap-3">
        <p className="eyebrow">{t("ui.entry.label")}</p>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-[32px] font-semibold tracking-[-0.03em]">
              {preview.name}
            </h1>
            <p className="mt-1 text-fog">
              {t("ui.entry.hostedBy", { owner: preview.ownerDisplayName })}
            </p>
          </div>
          <Chip tone={preview.status === "running" ? "running" : "neutral"}>
            {t(`gameStatuses.${preview.status}`)}
          </Chip>
        </div>
      </header>

      <section className="card grid grid-cols-2 gap-4" aria-label={t("ui.entry.facts")}>
        <div>
          <p className="eyebrow">{t("ui.entry.seats")}</p>
          <p className="mt-1 font-mono text-lg text-bone">{preview.playerCount}</p>
        </div>
        <div>
          <p className="eyebrow">{t("ui.entry.scheduled")}</p>
          <p className="mt-1 font-mono text-sm text-bone">
            {preview.scheduledAt === undefined
              ? t("ui.entry.manualStart")
              : scheduledLabel(preview.scheduledAt, i18n.language)}
          </p>
        </div>
      </section>

      <section className="card flex flex-col gap-3" aria-label={t("ui.entry.actions")}>
        {hasAction ? (
          <>
            {preview.canJoin && (
              <button
                className="btn btn--primary w-full"
                disabled={pending !== undefined}
                onClick={() => void admit("player")}
                type="button"
              >
                {t("ui.entry.join")}
              </button>
            )}
            {preview.canSpectate && (
              <button
                className="btn btn--ghost w-full"
                disabled={pending !== undefined}
                onClick={() => void admit("spectator")}
                type="button"
              >
                {t("ui.entry.spectate")}
              </button>
            )}
            {preview.canReplay && (
              <button
                className="btn btn--ghost w-full"
                disabled={pending !== undefined}
                onClick={() => void admit("replay")}
                type="button"
              >
                {t("ui.entry.replay")}
              </button>
            )}
            <ErrorMessage error={error} />
          </>
        ) : (
          <p className="text-sm text-fog" role="status">
            {t(`ui.entry.unavailable.${preview.unavailableReason ?? "cancelled"}`)}
          </p>
        )}
      </section>
    </div>
  );
}
