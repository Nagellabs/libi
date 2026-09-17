"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useUpdateSkillPrompt,
  useDeleteSkillPrompt,
  type EffectiveSkill,
  type SkillPromptUI,
} from "@/lib/queries/skills";
import { SkillBody } from "./skill-body";

interface Props {
  skill: EffectiveSkill;
  prompt: SkillPromptUI;
  /** Returns the editable user-row id, forking a bundled skill first if needed. */
  ensureOverride: () => Promise<string>;
  /** Called after a successful delete so the parent can re-select the overview. */
  onDeleted: () => void;
  /** Select an in-skill file (OVERVIEW_KEY or a prompt relPath) from a body reference. */
  onOpenRef?: (key: string) => void;
}

/** "prompts/hook.md" → "hook" (the bare kebab name the prompt routes expect). */
function bareName(relPath: string): string {
  return relPath.replace(/^prompts\//, "").replace(/\.md$/, "");
}

export function SkillPromptPane({ skill, prompt, ensureOverride, onDeleted, onOpenRef }: Props) {
  const update = useUpdateSkillPrompt();
  const del = useDeleteSkillPrompt();
  const isBundled = skill.source === "bundled";

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(prompt.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Re-seed when the selected prompt changes (and we're not mid-edit).
  useEffect(() => {
    if (!editing) setBody(prompt.body);
  }, [prompt.relPath, prompt.body, editing]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const targetId = await ensureOverride();
      await update.mutateAsync({ id: targetId, name: bareName(prompt.relPath), body });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    setSaving(true);
    setError(null);
    try {
      const targetId = await ensureOverride();
      await del.mutateAsync({ id: targetId, name: bareName(prompt.relPath) });
      setConfirmDelete(false);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-mono text-sm font-semibold">{prompt.relPath}</h2>
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer"
                onClick={() => {
                  setEditing(false);
                  setBody(prompt.body);
                  setError(null);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button size="sm" className="cursor-pointer" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button size="sm" className="cursor-pointer" onClick={() => setEditing(true)}>
              {isBundled ? "Override & Edit" : "Edit"}
            </Button>
          )}
        </div>
      </div>

      {isBundled && editing && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          Saving will create an editable override of this bundled skill.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {editing ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="w-full min-h-[200px] flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        ) : (
          <SkillBody
            text={prompt.body}
            prompts={skill.prompts}
            onOpenRef={onOpenRef}
            className="min-h-0 flex-1 overflow-auto"
          />
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!editing && (
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-destructive hover:underline"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-3.5" />
          Delete prompt
        </button>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {prompt.relPath}?</AlertDialogTitle>
            <AlertDialogDescription>
              {isBundled
                ? "This bundled skill will be overridden and the prompt removed from your copy. This cannot be undone."
                : "This prompt file will be permanently removed. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer" disabled={saving}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void doDelete();
              }}
              disabled={saving}
            >
              {saving ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
