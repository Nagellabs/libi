"use client";

import { useEffect, useRef } from "react";

export function ExportSuccessToast({
  filename,
  onOpenFolder,
  onDismiss,
}: {
  filename: string;
  onOpenFolder: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  // Latest-callback ref, written in an effect (never during render) so the
  // 10s auto-dismiss timer below never re-arms when the parent re-renders.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const t = setTimeout(() => dismissRef.current(), 10000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="libi-export-toast inline-flex max-w-xs items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs shadow-lg backdrop-blur-sm">
      <style>{`
        @keyframes libi-toast-in {
          from { opacity: 0; transform: translateY(6px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes libi-toast-check {
          0%   { stroke-dashoffset: 24; }
          100% { stroke-dashoffset: 0; }
        }
        .libi-export-toast.libi-animate { animation: libi-toast-in 220ms ease-out both; }
        .libi-export-toast.libi-animate .libi-toast-check-path {
          stroke-dasharray: 24;
          stroke-dashoffset: 24;
          animation: libi-toast-check 360ms ease-out 120ms forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          .libi-export-toast.libi-animate { animation: none; }
          .libi-export-toast.libi-animate .libi-toast-check-path {
            stroke-dashoffset: 0;
            animation: none;
          }
        }
      `}</style>

      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20">
        <svg
          className="text-emerald-600 dark:text-emerald-400"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path className="libi-toast-check-path" d="M5 13l4 4L19 7" />
        </svg>
      </span>

      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        <span className="text-emerald-700 dark:text-emerald-300">Exported </span>
        {filename}
      </span>

      <button
        type="button"
        onClick={onOpenFolder}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted/40"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        Open folder
      </button>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
