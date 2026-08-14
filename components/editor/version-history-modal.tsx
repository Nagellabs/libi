"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  useVersionHistory,
  useVersionDiff,
  useCommitDraft,
  useDiscardDraft,
  useRestoreSnapshot,
} from "@/lib/queries/snapshots";
import type { VersionRow } from "@/lib/queries/snapshots";
import { VersionDetailPanel } from "./version-detail-panel";
import { AlertTriangle } from "lucide-react";
import { trackEvent } from "@/lib/analytics/client";

interface Props {
  pieceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function marker(kind: VersionRow["kind"]): { sym: string; cls: string } {
  if (kind === "draft") return { sym: "●", cls: "text-amber-500" };
  if (kind === "snapshot") return { sym: "◆", cls: "text-foreground" };
  return { sym: "○", cls: "text-muted-foreground" };
}

function formatVersionTime(committedAt: number | null): string {
  if (!committedAt) return "just now";
  return new Date(committedAt * 1000).toLocaleString();
}

export function VersionHistoryModal({ pieceId, open, onOpenChange }: Props) {
  const { data: history } = useVersionHistory(pieceId, open);
  const versions = history?.versions ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<VersionRow | null>(null);

  const commit = useCommitDraft();
  const discard = useDiscardDraft();
  const restore = useRestoreSnapshot();

  // Default selection: draft if present, else current snapshot. Re-applied
  // whenever the modal opens or the version list first arrives. Adjusted
  // during render (each branch only sets when the value differs, so it's
  // self-limiting) — no setState-in-effect cascade.
  if (!open) {
    if (selectedId !== null) setSelectedId(null);
  } else if (!selectedId || !versions.some((v) => v.id === selectedId)) {
    const def =
      versions.find((v) => v.kind === "draft") ??
      versions.find((v) => v.kind === "snapshot");
    if (def && def.id !== selectedId) setSelectedId(def.id);
  }

  const { data: detail, isLoading: detailLoading } = useVersionDiff(
    pieceId,
    selectedId,
    open,
  );

  // The selected row drives the top toolbar actions. Reading kind from the row
  // (not `detail`) keeps the toolbar stable while the detail diff is loading.
  const selectedRow = versions.find((v) => v.id === selectedId);

  const handleRestoreConfirmed = () => {
    if (!restoreTarget) return;
    restore.mutate(
      { pieceId, snapshotId: restoreTarget.id },
      {
        onSuccess: () => {
          trackEvent("version_restore", {
            actor: restoreTarget.actor,
            had_missing_files: (restoreTarget.missingFileCount ?? 0) > 0,
          });
          setRestoreTarget(null);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex flex-col gap-0 overflow-hidden p-0 w-[70vw] max-w-[70vw] sm:max-w-[70vw] min-w-[min(680px,92vw)] h-[80vh] min-h-[420px]"
        >
          <TooltipProvider>
            {/* Top toolbar: title + contextual actions (mirrors the preview's
                primary Save button). Actions reflect the selected version. */}
            <DialogHeader className="flex h-12 shrink-0 flex-row items-center justify-between gap-3 border-b px-4">
              <DialogTitle>Version history</DialogTitle>
              <div className="flex items-center gap-2">
                {selectedRow?.kind === "draft" && (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          size="sm"
                          className="h-7 cursor-pointer"
                          disabled={commit.isPending}
                          onClick={() => commit.mutate({ pieceId, summary: "Manual edits" })}
                        >
                          Save snapshot
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Commit the current draft as a new snapshot you can return
                        to later.
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 cursor-pointer text-destructive"
                          disabled={discard.isPending}
                          onClick={() => discard.mutate({ pieceId })}
                        >
                          Discard draft
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Throw away all unsaved changes and revert to the current
                        snapshot. Can&apos;t be undone.
                      </TooltipContent>
                    </Tooltip>
                  </>
                )}
                {selectedRow?.kind === "history" && (
                  <>
                    {detail?.restoreImpact && (
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {detail.restoreImpact.totalChanges} change
                        {detail.restoreImpact.totalChanges === 1 ? "" : "s"} from
                        now
                      </span>
                    )}
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          size="sm"
                          className="h-7 cursor-pointer"
                          disabled={restore.isPending}
                          onClick={() => {
                            if (selectedRow) setRestoreTarget(selectedRow);
                          }}
                        >
                          Restore this version
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Replace the current snapshot with this version and discard
                        your draft. The current version is archived to history
                        first.
                      </TooltipContent>
                    </Tooltip>
                  </>
                )}
                {selectedRow?.kind === "snapshot" && (
                  <span className="text-xs text-muted-foreground">
                    Current version
                  </span>
                )}
              </div>
            </DialogHeader>

            <div className="flex min-h-0 flex-1">
              {/* Left rail — version timeline (scrolls independently; up to
                  12 rows: draft + current snapshot + 10 history entries). */}
              <div className="w-80 shrink-0 overflow-y-auto border-r">
                {versions.map((v) => {
                  const m = marker(v.kind);
                  const active = v.id === selectedId;
                  return (
                    <button
                      key={v.id}
                      onClick={() => setSelectedId(v.id)}
                      title={`${v.summary ?? (v.kind === "draft" ? "Unsaved draft" : "Untitled snapshot")} · saved ${formatVersionTime(v.committedAt)} by ${v.actor === "agent" ? "agent" : "you"}`}
                      className={`flex w-full flex-col gap-0.5 border-b border-l-2 px-3 py-2 text-left transition cursor-pointer hover:bg-accent ${
                        active
                          ? "border-l-primary bg-accent"
                          : "border-l-transparent"
                      }`}
                    >
                      <div className="flex items-start gap-1.5">
                        <span className={`${m.cls} leading-5`}>{m.sym}</span>
                        {/* Reserve 2 lines (min-h) so single-line summaries
                            don't make a shorter row; longer summaries expand. */}
                        <span className="min-h-[2.5rem] flex-1 break-words text-sm leading-5">
                          {v.kind === "draft"
                            ? "Draft · unsaved"
                            : v.kind === "snapshot"
                              ? (v.summary ?? "Snapshot (current)")
                              : (v.summary ?? "Untitled snapshot")}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {v.changeCount > 0 && (
                            <span className="rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">
                              ~{v.changeCount}
                            </span>
                          )}
                          {v.missingFileCount > 0 && (
                            <Tooltip>
                              <TooltipTrigger render={<span className="inline-flex text-red-400" />}>
                                <AlertTriangle className="h-3 w-3" />
                              </TooltipTrigger>
                              <TooltipContent>
                                This version references {v.missingFileCount}{" "}
                                deleted file(s) — those scenes/overlays will
                                appear blank.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      </div>
                      <span className="pl-5 text-[11px] font-normal text-muted-foreground">
                        {formatVersionTime(v.committedAt)} ·{" "}
                        {v.actor === "agent" ? "🤖" : "👤"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Detail */}
              <div className="flex-1 overflow-hidden">
                <VersionDetailPanel
                  pieceId={pieceId}
                  data={detail}
                  isLoading={detailLoading}
                  isOldest={
                    versions.length > 0 &&
                    versions[versions.length - 1].id === selectedId
                  }
                />
              </div>
            </div>
          </TooltipProvider>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(o) => {
          if (!o) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore &quot;{restoreTarget?.summary ?? "this version"}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The current snapshot moves to history (10-entry limit) and your
              draft, if any, is discarded.
              {(restoreTarget?.missingFileCount ?? 0) > 0 && (
                <span className="mt-2 block text-red-400">
                  ⚠ {restoreTarget?.missingFileCount} referenced file(s) were
                  deleted and will appear blank after restoring.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              disabled={restore.isPending}
              onClick={handleRestoreConfirmed}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
