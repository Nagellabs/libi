"use client";

import { useId, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { USER_LEVEL_INSTALLED_MESSAGE, type SkillInstallView } from "@/lib/agents/skill-installs-types";
import {
  SkillInstallRequestError,
  installsFor,
  useAddSkillInstall,
  useRemoveSkillInstall,
  useSkillInstalls,
} from "@/lib/queries/skill-installs";
import { cn } from "@/lib/utils";
import { FolderPickerField } from "./folder-picker-field";

function folderStatus(i: SkillInstallView): string {
  if (i.status === "folder-not-found") return "Folder not found";
  if (i.status === "error") return `Couldn't update: ${i.error ?? "unknown error"}`;
  return "Up to date";
}

function userStatus(i: SkillInstallView | null): string {
  if (!i) return "Not installed";
  if (i.status === "error") return `Couldn't update: ${i.error ?? "unknown error"}`;
  return `Installed · ${i.installedCount} skill${i.installedCount === 1 ? "" : "s"}`;
}

const DOT: Record<SkillInstallView["status"] | "none", string> = {
  none: "bg-muted-foreground/40",
  "up-to-date": "bg-emerald-500",
  "folder-not-found": "bg-amber-400",
  error: "bg-destructive",
};

/**
 * The skipped count, with the names behind a disclosure button: a `title`
 * alone is reachable only by mouse hover, never by keyboard or screen reader.
 */
function SkippedNote({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  const listId = useId();
  if (names.length === 0) return null;
  return (
    <>
      <span id={summaryId} className="text-xs text-amber-400" title={names.join(", ")}>
        Skipped {names.length} skill{names.length === 1 ? "" : "s"} whose name{names.length === 1 ? "" : "s"} you already use
      </span>
      <button
        type="button"
        className="cursor-pointer text-xs text-amber-400 underline underline-offset-2 hover:text-amber-300"
        aria-expanded={open}
        aria-controls={listId}
        aria-describedby={summaryId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide names" : "Show names"}
      </button>
      <ul id={listId} hidden={!open} className="w-full list-disc pl-5 font-mono text-[11px] text-amber-400">
        {names.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  );
}

function folderCountText(n: number): string {
  return `${n} folder${n === 1 ? "" : "s"}`;
}

/**
 * The two skills rows of one agent's card on the Global setup tab: libi's skills
 * for every folder (the agent's user-level dir) and in specific folders. Both
 * are recorded installs libi keeps up to date; Install / Add is the consent,
 * Remove asks first and deletes only libi's own files. The rows do not depend
 * on the agent's CLI state — skills are files, not a registration.
 */
export function AgentSkillInstalls({ agentId, name }: { agentId: SetupAgentId; name: string }) {
  const query = useSkillInstalls({ poll: true });
  const add = useAddSkillInstall();
  const remove = useRemoveSkillInstall();
  const { user, folders } = installsFor(query.data, agentId);
  const userDir = query.data?.userSkillsDirs[agentId] ?? "";
  const [adding, setAdding] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SkillInstallView | null>(null);
  const [confirmEveryFolder, setConfirmEveryFolder] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ id: string; message: string } | null>(null);

  const installUser = async () => {
    setConfirmEveryFolder(false);
    setUserError(null);
    try {
      await add.mutateAsync({ agentId, scope: "user" });
    } catch (err) {
      setUserError(err instanceof SkillInstallRequestError && err.message ? err.message : "Couldn't install libi's skills. Try again.");
    }
  };

  const submitFolder = async () => {
    setAddError(null);
    try {
      await add.mutateAsync({ agentId, scope: "folder", folderPath: folderPath.trim() });
      setAdding(false);
      setFolderPath("");
    } catch (err) {
      setAddError(err instanceof SkillInstallRequestError && err.message ? err.message : "Couldn't install libi's skills. Try again.");
    }
  };

  const cancelAdding = () => {
    setAdding(false);
    setFolderPath("");
    setAddError(null);
  };

  const doRemove = async () => {
    const target = confirmRemove;
    setConfirmRemove(null);
    if (!target) return;
    setRemoveError(null);
    try {
      await remove.mutateAsync(target.id);
    } catch (err) {
      setRemoveError({
        id: target.id,
        message: err instanceof SkillInstallRequestError && err.message ? err.message : "Couldn't remove libi's skills. Try again.",
      });
    }
  };

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton data-testid="skills-skeleton" className="h-14 w-full" />
        <Skeleton data-testid="skills-skeleton" className="h-14 w-full" />
      </div>
    );
  }

  if (!query.data) {
    return (
      <div
        data-testid={`skills-error-${agentId}`}
        className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-foreground"
      >
        <span>{"Couldn't read libi's skill installs."}</span>
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div data-testid={`skills-user-row-${agentId}`} className="flex min-h-12 items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-foreground">Every folder</div>
          <p className="text-xs text-muted-foreground">
            {`Installs libi's skills into ${userDir}, so every ${name} chat in every folder can use them. libi keeps them up to date.`}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[user?.status ?? "none"])} />
            <span>{userStatus(user)}</span>
            {user ? <SkippedNote names={user.skippedNames} /> : null}
          </div>
          {!user && userError ? (
            <p role="alert" className="text-xs text-destructive">
              {userError}
            </p>
          ) : null}
          {user && removeError?.id === user.id ? (
            <p role="alert" className="text-xs text-destructive">
              {removeError.message}
            </p>
          ) : null}
        </div>
        <div className="shrink-0">
          {user ? (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              disabled={remove.isPending}
              onClick={() => setConfirmRemove(user)}
            >
              Remove
            </Button>
          ) : (
            <Button
              size="sm"
              className="cursor-pointer"
              disabled={add.isPending}
              onClick={() => (folders.length > 0 ? setConfirmEveryFolder(true) : void installUser())}
            >
              Install
            </Button>
          )}
        </div>
      </div>

      <div data-testid={`skills-folders-row-${agentId}`} className="space-y-2 rounded-lg bg-muted/40 px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="text-sm text-foreground">Specific folders</div>
            <p className="text-xs text-muted-foreground">
              {`Installs libi's skills only into the folders you add, for ${name} chats that work in them. libi keeps them up to date.`}
            </p>
          </div>
          <Button
            data-testid={`skills-add-folder-${agentId}`}
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={user !== null || adding}
            onClick={() => {
              setAddError(null);
              setAdding(true);
            }}
          >
            Add folder
          </Button>
        </div>
        {user ? <p className="text-xs text-muted-foreground">{USER_LEVEL_INSTALLED_MESSAGE}</p> : null}
        {!user && folders.length === 0 && !adding ? <p className="text-xs text-muted-foreground">No folders yet.</p> : null}
        {folders.map((f) => (
          <div key={f.id} data-testid={`skills-folder-${f.id}`} className="flex items-start justify-between gap-3 border-t border-border/60 pt-2">
            <div className="min-w-0 space-y-0.5">
              <div className="truncate font-mono text-xs text-foreground" title={f.path}>
                {f.path}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[f.status])} />
                <span>{folderStatus(f)}</span>
                {f.source === "cli" ? <span className="rounded bg-muted px-1 py-0.5 text-[11px]">added with libi connect</span> : null}
                <SkippedNote names={f.skippedNames} />
              </div>
              {removeError?.id === f.id ? (
                <p role="alert" className="text-xs text-destructive">
                  {removeError.message}
                </p>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 cursor-pointer"
              disabled={remove.isPending}
              onClick={() => setConfirmRemove(f)}
            >
              Remove
            </Button>
          </div>
        ))}
        {adding ? (
          <div className="space-y-2 border-t border-border/60 pt-2">
            <FolderPickerField
              testId={`folder-picker-${agentId}`}
              value={folderPath}
              onChange={setFolderPath}
              onSubmit={() => void submitFolder()}
              submitLabel="Add"
              submitting={add.isPending}
              error={addError}
            />
            <Button variant="outline" size="sm" className="cursor-pointer" disabled={add.isPending} onClick={cancelAdding}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>

      <AlertDialog open={confirmRemove !== null} onOpenChange={(open) => !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove libi&#39;s skills?</AlertDialogTitle>
            <AlertDialogDescription>
              {`Removes libi's skills from ${confirmRemove?.path ?? ""}. Skills you added there yourself stay.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" disabled={remove.isPending} onClick={() => void doRemove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmEveryFolder} onOpenChange={setConfirmEveryFolder}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install for every folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This also removes libi's skills from your ${folderCountText(folders.length)}, since every folder will have them.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" disabled={add.isPending} onClick={() => void installUser()}>
              Install
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
