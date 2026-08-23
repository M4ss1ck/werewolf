import {
  createContext,
  type JSX,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ApiError } from "./api/client.ts";
import { i18n } from "./i18n/i18n.ts";

export type ToastTone = "error" | "warning" | "success";

type ToastState = {
  tone: ToastTone;
  text: string;
};

type ToastApi = {
  show(tone: ToastTone, text: string): void;
  showError(error: unknown): void;
  dismiss(): void;
};

const SWIPE_THRESHOLD = 80;
const EXIT_MS = 200;
const FLY_OUT = 600;

const ToastContext = createContext<ToastApi | undefined>(undefined);

const NOOP_TOAST: ToastApi = {
  show: () => undefined,
  showError: () => undefined,
  dismiss: () => undefined,
};

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP_TOAST;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toast, setToast] = useState<ToastState | undefined>(undefined);
  const [entered, setEntered] = useState(false);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const startXRef = useRef<number | undefined>(undefined);
  const pointerIdRef = useRef<number | undefined>(undefined);
  const exitTimerRef = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    if (exitTimerRef.current !== undefined) return;
    const next = offsetRef.current >= 0 ? FLY_OUT : -FLY_OUT;
    offsetRef.current = next;
    setOffset(next);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = undefined;
      setToast(undefined);
      setEntered(false);
      offsetRef.current = 0;
      setOffset(0);
    }, EXIT_MS);
  }, []);

  const show = useCallback((tone: ToastTone, text: string) => {
    if (exitTimerRef.current !== undefined) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = undefined;
    }
    setToast({ tone, text });
    setEntered(false);
    offsetRef.current = 0;
    setOffset(0);
  }, []);

  const showError = useCallback(
    (error: unknown) => {
      const code = (error as Partial<ApiError>).code ?? "UNKNOWN_ERROR";
      show("error", i18n.t(`errors.${code}`, { defaultValue: i18n.t("errors.UNKNOWN_ERROR") }));
    },
    [show],
  );

  const value = useMemo(() => ({ show, showError, dismiss }), [dismiss, show, showError]);

  useEffect(() => {
    if (toast === undefined) return;
    const id = window.setTimeout(() => setEntered(true), 0);
    return () => window.clearTimeout(id);
  }, [toast]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (exitTimerRef.current !== undefined) return;
    startXRef.current = event.clientX;
    pointerIdRef.current = event.pointerId;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId || startXRef.current === undefined) return;
    const next = event.clientX - startXRef.current;
    offsetRef.current = next;
    setOffset(next);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = undefined;
    startXRef.current = undefined;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (Math.abs(offsetRef.current) >= SWIPE_THRESHOLD) {
      dismiss();
    } else {
      offsetRef.current = 0;
      setOffset(0);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = undefined;
    startXRef.current = undefined;
    offsetRef.current = 0;
    setOffset(0);
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast !== undefined && (
        <div
          aria-live="polite"
          className={`toast toast--${toast.tone}${entered ? " toast--entered" : ""}`}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="status"
          style={{ transform: `translateX(${offset}px)` }}
        >
          <span className="toast__text">{toast.text}</span>
          <button
            aria-label={i18n.t("ui.dismiss")}
            className="toast__dismiss"
            onClick={dismiss}
            type="button"
          >
            ×
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
