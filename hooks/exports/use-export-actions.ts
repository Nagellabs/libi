"use client";

import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics/client";
import { copyFileToClipboard, getShellPlatform, revealFile, revealLabel } from "@/lib/shell/client";
import { fetchExportLocation, useDeleteExport, useRenameExport } from "@/lib/queries/exports";
import { openPostingTab } from "@/hooks/social/use-posting-intent";
import { MISSING_FILE_MESSAGE, type ExportRecordView } from "@/lib/exports/types";

/** Where the action was taken — the `export_action` event's `surface`. */
export type ExportSurface = "tab" | "resources";

export const COPIED_FILE_TOAST = "Copied — paste it in Finder, Messages or Slack";
export const COPIED_PATH_TOAST = "Copied the file's location";

export interface ExportActions {
  /** Platform-native wording: "Reveal in Finder", "Show in File Explorer", … */
  revealLabel: string;
  reveal: (e: ExportRecordView) => Promise<void>;
  copy: (e: ExportRecordView) => Promise<void>;
  /** Open the piece's Posting tab with the composer started on this export. */
  post: (e: ExportRecordView) => void;
  /** True when renamed; a refusal is toasted in the route's own words. */
  rename: (e: ExportRecordView, name: string) => Promise<boolean>;
  /** Delete (a queued/running export is cancelled first, server-side). */
  remove: (e: ExportRecordView) => Promise<boolean>;
  /** The user started playing it. */
  played: () => void;
}

/** The actions on one export, shared by the Exports tab and the resources panel (spec §A6). */
export function useExportActions(surface: ExportSurface): ExportActions {
  const renameMutation = useRenameExport();
  const deleteMutation = useDeleteExport();

  /** The file's path now — or null, having said "Missing file", when it is not on disk. */
  const locate = async (e: ExportRecordView): Promise<string | null> => {
    if (e.missing) {
      toast.error(MISSING_FILE_MESSAGE);
      return null;
    }
    const loc = await fetchExportLocation(e.id);
    if (!loc?.exists) {
      toast.error(MISSING_FILE_MESSAGE);
      return null;
    }
    return loc.path;
  };

  return {
    revealLabel: revealLabel(getShellPlatform()),
    reveal: async (e) => {
      const p = await locate(e);
      if (!p) return;
      trackEvent("export_action", { action: "reveal", surface });
      // Fire-and-forget by design (see lib/shell/client.ts#revealFileById).
      await revealFile(p).catch(() => {});
    },
    copy: async (e) => {
      const p = await locate(e);
      if (!p) return;
      let copiedFile: boolean | undefined;
      try {
        copiedFile = await copyFileToClipboard(p);
      } catch {
        copiedFile = false;
      }
      if (copiedFile) {
        trackEvent("export_action", { action: "copy", surface });
        toast.success(COPIED_FILE_TOAST);
        return;
      }
      try {
        await navigator.clipboard.writeText(p);
      } catch {
        toast.error("Couldn't copy to the clipboard.");
        return;
      }
      trackEvent("export_action", { action: "copy_path", surface });
      toast.success(COPIED_PATH_TOAST);
    },
    post: (e) => {
      if (e.status !== "done") {
        toast.error("Only a finished export can be posted.");
        return;
      }
      if (e.missing || !e.path) {
        toast.error(MISSING_FILE_MESSAGE);
        return;
      }
      trackEvent("export_action", { action: "post", surface });
      openPostingTab({ pieceId: e.pieceId, exportPath: e.path });
    },
    rename: async (e, name) => {
      try {
        await renameMutation.mutateAsync({ exportId: e.id, name });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      }
      trackEvent("export_action", { action: "rename", surface });
      return true;
    },
    remove: async (e) => {
      try {
        await deleteMutation.mutateAsync(e.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      }
      trackEvent("export_action", { action: "delete", surface });
      return true;
    },
    played: () => trackEvent("export_action", { action: "play", surface }),
  };
}
