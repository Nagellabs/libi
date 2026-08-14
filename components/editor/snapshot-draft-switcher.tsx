"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEditorState } from "@/lib/editor-state-context";
import { usePieceState, useCommitDraft, useDiscardDraft } from "@/lib/queries/snapshots";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { MoreHorizontal, Loader2 } from "lucide-react";
import { SaveSnapshotPopover } from "./save-snapshot-popover";
import { VersionHistoryModal } from "./version-history-modal";

interface Props {
  pieceId: string;
}

/** POST a programmatic message to the active agent session. Returns true if sent. */
async function sendAgentSaveMessage(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/agent/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        text: "Save the current draft as a snapshot. Use libi.compare_states to review what changed, then call libi.commit_draft with a meaningful one-line summary describing the changes.",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function SnapshotDraftSwitcher({ pieceId }: Props) {
  const { viewMode, setViewMode, sessionList } = useEditorState();
  const { data: state } = usePieceState(pieceId);
  const commit = useCommitDraft();
  const discard = useDiscardDraft();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** True while an agent-driven save request is in flight. */
  const [agentSaving, setAgentSaving] = useState(false);
  const agentSavingRef = useRef(false);

  const hasDraft = state?.hasDraft ?? false;

  /**
   * Primary Save action:
   *  1. If an active session exists → send a programmatic chat message asking
   *     the agent to compare states and commit_draft with a real summary.
   *  2. Fallback → commit directly with "Manual edits" and show a console note.
   *
   * Debounced: a second click while in-flight is a no-op.
   */
  const handlePrimarySave = useCallback(async () => {
    if (agentSavingRef.current || !hasDraft) return;
    agentSavingRef.current = true;
    setAgentSaving(true);
    try {
      const activeSessionId = sessionList.activeSessionId;
      if (activeSessionId) {
        const sent = await sendAgentSaveMessage(activeSessionId);
        if (!sent) {
          // Agent send failed — fall back to direct commit
          commit.mutate({ pieceId, summary: "Manual edits" });
        }
        // If sent OK, the snapshot saves when the agent calls commit_draft.
        // The SSE refresh will update the UI automatically.
      } else {
        // No active session — direct commit
        commit.mutate({ pieceId, summary: "Manual edits" });
      }
    } finally {
      agentSavingRef.current = false;
      setAgentSaving(false);
    }
  }, [hasDraft, sessionList.activeSessionId, commit, pieceId]);

  /** Caret-dropdown: user typed a custom name → direct commit, no agent. */
  const handleNamedSave = useCallback((summary: string) => {
    commit.mutate({ pieceId, summary });
  }, [commit, pieceId]);

  // Keyboard shortcuts: Cmd+S to save, Cmd+Shift+Z to discard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Skip if typing in input, textarea, or contenteditable
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      if (!cmdOrCtrl) return;

      // Cmd+S — Save (only when hasDraft). Uses same primary-save logic as the button.
      if (e.key === "s" && !e.shiftKey) {
        e.preventDefault();
        if (hasDraft) {
          void handlePrimarySave();
        }
        return;
      }

      // Cmd+Shift+Z — Discard with confirm (only when hasDraft)
      if (e.key === "z" && e.shiftKey) {
        e.preventDefault();
        if (hasDraft) {
          setDiscardOpen(true);
        }
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [hasDraft, handlePrimarySave]);

  return (
    <div className="flex items-center gap-1">
      <div className="inline-flex items-center rounded-md border bg-background p-0.5 text-xs">
        <button
          onClick={() => setViewMode("snapshot")}
          title="Viewing the last saved version of this piece"
          className={`cursor-pointer rounded px-2 py-1 transition ${
            viewMode === "snapshot" ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
        >
          Snapshot
        </button>
        <button
          onClick={() => setViewMode("draft")}
          title={hasDraft ? "Your working copy with unsaved changes" : "Your working copy — edit here"}
          className={`cursor-pointer rounded px-2 py-1 transition ${
            viewMode === "draft" ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
        >
          {hasDraft && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />}
          Draft
        </button>
      </div>

      {/* Inline split Save button — only visible when there is a draft to save */}
      {hasDraft && (
        <div className="inline-flex h-7 items-stretch rounded-md overflow-hidden text-xs font-medium bg-primary text-primary-foreground">
          {/* Primary action: agent-driven save */}
          <button
            onClick={() => void handlePrimarySave()}
            disabled={agentSaving}
            title={agentSaving ? "Saving…" : "Commit the current draft as a new snapshot you can return to later."}
            className="cursor-pointer inline-flex items-center justify-center gap-1.5 px-3 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {agentSaving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            Save
          </button>
          {/* Caret: open popover for a custom snapshot name */}
          <SaveSnapshotPopover onSave={handleNamedSave} disabled={agentSaving} />
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger className="cursor-pointer inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-52 whitespace-nowrap">
          <DropdownMenuItem
            disabled={!hasDraft}
            onClick={() => commit.mutate({ pieceId, summary: "Manual edits" })}
            className="cursor-pointer"
            title="Commit the current draft as a new snapshot you can return to later."
          >
            Save as snapshot
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!hasDraft}
            onClick={() => setDiscardOpen(true)}
            className="cursor-pointer text-destructive"
            title="Throw away all unsaved changes and revert to the current snapshot. Can't be undone."
          >
            Discard draft
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            // Defer one frame so the dropdown finishes closing and releases
            // focus from the ⋯ trigger BEFORE the dialog mounts and aria-hides
            // the background — otherwise the focused trigger sits inside an
            // aria-hidden subtree (a11y warning).
            onClick={() => requestAnimationFrame(() => setHistoryOpen(true))}
            className="cursor-pointer"
          >
            Version history
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <VersionHistoryModal pieceId={pieceId} open={historyOpen} onOpenChange={setHistoryOpen} />

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved changes will be replaced with the snapshot. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              variant="destructive"
              onClick={() => {
                discard.mutate({ pieceId }, {
                  onSuccess: () => setDiscardOpen(false),
                });
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
