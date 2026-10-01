"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { refreshQueryEmitter } from "@/hooks/sessions/use-agent-chat";
import { openExportInTab } from "@/hooks/exports/use-open-export";
import { isExportForPost, openPostingTab } from "@/hooks/social/use-posting-intent";
import { trackEvent } from "@/lib/analytics/client";
import { droppedClipsNote } from "@/lib/export/dropped-overlays";
import type { ExportRecordView } from "@/lib/exports/types";

export function finishToastTitle(e: Pick<ExportRecordView, "pieceName" | "name">): string {
  return `${e.pieceName ?? "Your piece"}: ${e.name} is ready`;
}

/**
 * One toast per export that finishes (spec 2026-09-29 §B2) — any piece, any
 * page, whoever started it. Driven by the one SSE's `refresh_query exports`
 * events carrying `status: "done" | "failed"`; the record is read once for its
 * name. Mounted once, at the (app) layout (app/(app)/global-refresh-mount.tsx).
 */
export function useExportFinishToasts(): void {
  const router = useRouter();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const open = (e: ExportRecordView) => {
      openExportInTab({ pieceId: e.pieceId, exportId: e.id });
      if (typeof window !== "undefined" && window.location.pathname !== "/editor") router.push("/editor");
    };
    // The post this export was made for: the Posting tab, with the composer
    // picking the export up.
    const continuePost = (e: ExportRecordView) => {
      openPostingTab({ pieceId: e.pieceId, awaitExportId: e.id });
      if (typeof window !== "undefined" && window.location.pathname !== "/editor") router.push("/editor");
    };
    return refreshQueryEmitter.on((event) => {
      if (event.queryKey !== "exports" || !event.exportId) return;
      if (event.status !== "done" && event.status !== "failed") return;
      const key = `${event.exportId}:${event.status}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      const exportId = event.exportId;
      const status = event.status;
      void (async () => {
        const res = await fetch(`/api/exports/${encodeURIComponent(exportId)}`).catch(() => null);
        if (!res?.ok) {
          // Not read: let a later event for this export try again rather than lose its toast.
          seen.current.delete(key);
          return;
        }
        const e = ((await res.json()) as { export: ExportRecordView }).export;
        if (status === "done") {
          const note = droppedClipsNote(e.droppedOverlays ?? undefined);
          const forPost = isExportForPost(e.id);
          toast.success(finishToastTitle(e), {
            ...(note ? { description: note } : {}),
            // A note says the file is missing something: it stays until read.
            duration: note ? Infinity : 8000,
            // An export made for a post offers to carry on with that post;
            // Open stays one click away beside it.
            action: forPost ? { label: "Continue post", onClick: () => continuePost(e) } : { label: "Open", onClick: () => open(e) },
            ...(forPost ? { cancel: { label: "Open", onClick: () => open(e) } } : {}),
          });
          trackEvent("export_completed", { backend: e.backend ?? "unknown", format: e.container, quality: e.quality ?? "source" });
          if (e.source === "user") {
            void fetch("/api/analytics/milestone", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "export", event: "first_export" }),
            }).catch(() => {});
          }
        } else {
          toast.error(`${e.pieceName ?? "Your piece"}: ${e.name} failed`, {
            ...(e.error ? { description: e.error } : {}),
            action: { label: "Open", onClick: () => open(e) },
          });
        }
      })();
    });
  }, [router]);
}
