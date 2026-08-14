"use client";

import { useMemo, useState } from "react";
import type { ManualAnchor } from "@/lib/tracking/types";

function mmss(time: number): string {
  const m = Math.floor(time / 60);
  const s = Math.floor(time % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface ManualEditsPanelProps {
  anchors: ManualAnchor[];
  onJump: (time: number) => void;
  /** Commit the staged deletions. The server removes these anchors AND
   *  re-tracks the windows they corrected without them. */
  onApplyDeletes: (anchorIds: string[]) => void | Promise<void>;
  onRetrack: () => void;
  /** Short label of the overlay this panel is scoped to (e.g. the emoji
   *  char). Shown so multi-overlay videos make clear which overlay's
   *  anchors are listed. */
  scopeLabel?: string;
}

/**
 * The reusable manual-edit control surface, modelled as an EDIT FORM:
 * deleting marks a row for removal (strike-through + Undo) but does NOT hit
 * the server. The user can stage several removals, then "Save changes"
 * commits them in one pass — which removes the anchors AND re-tracks the
 * freed windows without the corrections (a bare delete would be a visual
 * no-op, since the segment samples were re-tracked WITH the correction
 * baked in). "Cancel" discards the staged removals.
 */
export function ManualEditsPanel({
  anchors, onJump, onApplyDeletes, onRetrack, scopeLabel,
}: ManualEditsPanelProps) {
  // Ids staged for deletion (not yet committed). A Set keeps toggle cheap.
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Drop staged ids that no longer exist (e.g. an external refresh removed
  // them) so the dirty footer can't get stuck on phantom ids.
  const stagedLive = useMemo(() => {
    const ids = new Set(anchors.map((a) => a.id));
    return new Set([...staged].filter((id) => ids.has(id)));
  }, [staged, anchors]);

  const dirty = stagedLive.size > 0;

  const toggle = (id: string) =>
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (stagedLive.size === 0 || saving) return;
    setSaving(true);
    try {
      await onApplyDeletes([...stagedLive]);
      setStaged(new Set());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="manual-edits-panel"
      className="flex flex-col gap-2 border-t border-border bg-surface px-4 py-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Manual re-anchors ({anchors.length})
          {scopeLabel ? (
            <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
              {scopeLabel}
            </span>
          ) : null}
        </span>
        <div className="flex gap-2">
          <button
            data-testid="manual-edit-retrack"
            onClick={onRetrack}
            className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Re-track from corrections
          </button>
          <button
            data-testid="manual-edit-clear-all"
            onClick={() => setStaged(new Set(anchors.map((a) => a.id)))}
            disabled={anchors.length === 0}
            className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      </div>
      {anchors.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Drag a tracked overlay in the preview to add a correction.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {anchors.map((a) => {
            const isStaged = stagedLive.has(a.id);
            return (
              <li
                key={a.id}
                className={`flex items-center justify-between rounded px-2 py-1 ${
                  isStaged ? "bg-rose-500/10" : "bg-background"
                }`}
              >
                <span
                  className={`font-mono text-[11px] ${
                    isStaged
                      ? "text-rose-300/70 line-through"
                      : "text-foreground"
                  }`}
                >
                  {mmss(a.time)}
                </span>
                <span className="flex gap-2">
                  <button
                    data-testid={`manual-edit-jump-${a.id}`}
                    onClick={() => onJump(a.time)}
                    className="cursor-pointer text-[11px] text-amber-500 hover:underline"
                  >
                    Jump
                  </button>
                  {isStaged ? (
                    <button
                      data-testid={`manual-edit-undo-${a.id}`}
                      onClick={() => toggle(a.id)}
                      className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Undo
                    </button>
                  ) : (
                    <button
                      data-testid={`manual-edit-delete-${a.id}`}
                      onClick={() => toggle(a.id)}
                      className="cursor-pointer text-[11px] text-muted-foreground hover:text-destructive"
                    >
                      Delete
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {dirty && (
        <div
          data-testid="manual-edit-dirty-footer"
          className="flex flex-col gap-2 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1.5"
        >
          <span className="text-[11px] leading-snug text-rose-300/90">
            {stagedLive.size} marked for removal — saving re-tracks{" "}
            {stagedLive.size === 1 ? "that segment" : "those segments"} without
            the correction.
          </span>
          <span className="flex shrink-0 justify-end gap-2">
            <button
              data-testid="manual-edit-cancel"
              onClick={() => setStaged(new Set())}
              disabled={saving}
              className="cursor-pointer rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              data-testid="manual-edit-save"
              onClick={save}
              disabled={saving}
              className="cursor-pointer rounded bg-amber-500/90 px-2.5 py-1 text-[11px] font-medium text-amber-950 hover:bg-amber-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
