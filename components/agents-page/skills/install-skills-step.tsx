"use client";

import { useState } from "react";
import Link from "next/link";
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
import { SkillInstallRequestError, installsFor, useAddSkillInstall, useSkillInstalls } from "@/lib/queries/skill-installs";
import { wizardAgentName } from "@/components/agents-page/agents-tab/wizard-state";
import { FolderPickerField } from "./folder-picker-field";

type Choice = "user" | "folder";

/** Only the route's own message is shown verbatim; anything else — or an empty message — gets fixed wording. */
function installErrorMessage(err: unknown): string {
  return err instanceof SkillInstallRequestError && err.message ? err.message : "Couldn't install libi's skills. Try again.";
}

/**
 * Part 2 of "use libi from your own app or terminal", shown once the tools
 * read Connected: install libi's skills for every folder or for one folder.
 * Installs directly (pressing Install is the consent) and is recorded, so it
 * shows up on the Global setup tab and stays current. There is no Skip — the whole
 * section is optional already, and a connected agent without skills is the
 * state this step exists to end.
 */
export function InstallSkillsStep({ agent }: { agent: SetupAgentId }) {
  const name = wizardAgentName(agent);
  const query = useSkillInstalls({ poll: true });
  const add = useAddSkillInstall();
  const { user, folders } = installsFor(query.data, agent);
  const userDir = query.data?.userSkillsDirs[agent] ?? "";
  const [choice, setChoice] = useState<Choice>("user");
  const [choosing, setChoosing] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmEveryFolder, setConfirmEveryFolder] = useState(false);

  const installUser = async () => {
    setConfirmEveryFolder(false);
    setError(null);
    try {
      await add.mutateAsync({ agentId: agent, scope: "user" });
      setChoosing(false);
    } catch (err) {
      setError(installErrorMessage(err));
    }
  };

  const installFolder = async () => {
    setError(null);
    try {
      await add.mutateAsync({ agentId: agent, scope: "folder", folderPath: folderPath.trim() });
      setChoosing(false);
      setFolderPath("");
    } catch (err) {
      setError(installErrorMessage(err));
    }
  };

  if (query.isLoading) {
    return (
      <div data-testid="wizard-install-skills" className="space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!query.data) {
    return (
      <div
        data-testid="wizard-install-skills"
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

  const hasInstall = user !== null || folders.length > 0;
  const showChoice = !hasInstall || choosing;
  const cancelChoosing = () => {
    setChoosing(false);
    setError(null);
    setFolderPath("");
  };

  return (
    <div data-testid="wizard-install-skills" className="space-y-3">
      {showChoice ? (
        <>
          <p className="text-sm text-muted-foreground">{`libi's tools are connected. Now install libi's skills so ${name} knows how to use them.`}</p>
          <div role="radiogroup" aria-label="Where to install libi's skills" className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name={`skills-level-${agent}`}
                className="mt-1 cursor-pointer"
                checked={choice === "user"}
                onChange={() => {
                  setChoice("user");
                  setError(null);
                }}
              />
              <span>
                <span className="text-foreground">Every folder</span>
                <span className="block text-xs text-muted-foreground">{`Installs into ${userDir}. Every ${name} chat in every folder can use them.`}</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name={`skills-level-${agent}`}
                className="mt-1 cursor-pointer"
                checked={choice === "folder"}
                onChange={() => {
                  setChoice("folder");
                  setError(null);
                }}
              />
              <span className="text-foreground">A specific folder</span>
            </label>
          </div>
          {choice === "user" ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                className="cursor-pointer"
                disabled={add.isPending}
                onClick={() => (folders.length > 0 ? setConfirmEveryFolder(true) : void installUser())}
              >
                Install
              </Button>
              {choosing ? (
                <Button variant="outline" size="sm" className="cursor-pointer" onClick={cancelChoosing}>
                  Cancel
                </Button>
              ) : null}
              {error ? (
                <p role="alert" className="w-full text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <FolderPickerField
                testId={`wizard-folder-picker-${agent}`}
                value={folderPath}
                onChange={setFolderPath}
                onSubmit={() => void installFolder()}
                submitLabel="Install"
                submitting={add.isPending}
                error={error}
              />
              {choosing ? (
                <Button variant="outline" size="sm" className="cursor-pointer" onClick={cancelChoosing}>
                  Cancel
                </Button>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <p data-testid="wizard-install-skills-summary" className="text-sm text-muted-foreground">
            {user ? "Skills installed for every folder" : `Skills installed in ${folders.length} folder${folders.length === 1 ? "" : "s"}`}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {user ? null : (
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer"
                onClick={() => {
                  setChoice("folder");
                  setError(null);
                  setChoosing(true);
                }}
              >
                Add another folder
              </Button>
            )}
            <Link href={`/agents?tab=global-setup&setupAgent=${agent}`} className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
              Manage on the Global setup tab
            </Link>
          </div>
        </div>
      )}

      <AlertDialog open={confirmEveryFolder} onOpenChange={setConfirmEveryFolder}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install for every folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This also removes libi's skills from your ${folders.length} folder${folders.length === 1 ? "" : "s"}, since every folder will have them.`}
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
