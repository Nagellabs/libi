"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  useInstructionsDoc,
  useSaveInstructionsOverride,
  useRevertInstructionsOverride,
} from "@/lib/queries/instructions";
import { MarkdownDoc } from "./markdown-doc";

interface Props {
  /** Lets the page shell switch to a full-height (non-scrolling) layout while editing. */
  onEditingChange?: (editing: boolean) => void;
}

export function InstructionsView({ onEditingChange }: Props) {
  const { data, isLoading } = useInstructionsDoc();
  const save = useSaveInstructionsOverride();
  const revert = useRevertInstructionsOverride();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);

  const setEditMode = (value: boolean) => {
    setEditing(value);
    onEditingChange?.(value);
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const isOverride = data.source === "override";

  const startEditing = () => {
    setText(data.content);
    setEditMode(true);
  };

  return (
    <div className={editing ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Agent instructions</h2>
        <Badge
          variant="outline"
          className={isOverride ? "border-border text-muted-foreground" : "border-primary text-primary"}
        >
          {isOverride ? "user" : "bundled"}
        </Badge>
        {isOverride && (
          <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
            overridden
          </Badge>
        )}
        {isOverride && data.bundledUpdatedSinceFork === true && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge
                  variant="outline"
                  className="cursor-default border-blue-500/50 text-blue-600 dark:text-blue-400"
                >
                  bundled updated
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">
                  The bundled instructions shipped with libi have been updated since you
                  overrode them. Revert the override to take the update, or merge the
                  changes into your copy manually.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="cursor-pointer"
                onClick={() => setEditMode(false)}
              >
                Cancel
              </Button>
              <AlertDialog key="save-confirm" open={saveConfirmOpen} onOpenChange={setSaveConfirmOpen}>
                <AlertDialogTrigger
                  render={<Button size="sm" className="cursor-pointer" />}
                  disabled={text.trim().length === 0 || save.isPending}
                >
                  {save.isPending ? "Saving…" : "Save override"}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Save instruction override?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Saving will <strong>terminate all running agent sessions</strong> so the
                      new instructions take effect immediately.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="cursor-pointer"
                      onClick={() => {
                        save.mutate(text, {
                          onSuccess: () => {
                            setSaveConfirmOpen(false);
                            setEditMode(false);
                          },
                        });
                      }}
                    >
                      Save and restart
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                or ask your agent to do it
              </span>
              {!isOverride && (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button size="sm" variant="outline" className="cursor-pointer" />}>
                    Override
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Override the base instructions?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Overriding is <strong>discouraged</strong> — for behavior changes, prefer
                        Memories (the agent stays aligned with libi updates). Override only when a
                        specific base behavior conflicts with what you want and a memory can&apos;t
                        win against it. You&apos;ll get an editable copy; you can revert to the
                        bundled instructions at any time.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                      <AlertDialogAction className="cursor-pointer" onClick={startEditing}>
                        Create editable copy
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              {isOverride && (
                <>
                  <Button size="sm" variant="outline" className="cursor-pointer" onClick={startEditing}>
                    Edit
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button size="sm" variant="ghost" className="cursor-pointer" />}>
                      Revert to bundled
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revert to the bundled instructions?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Your override will be deleted and the bundled instructions restored.
                          All running agent sessions will be <strong>terminated</strong>.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="cursor-pointer"
                          onClick={() => revert.mutate()}
                        >
                          Revert and restart
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {!editing && !isOverride && (
        <p className="text-sm text-muted-foreground">
          This is how the agent behaves — the exact instructions injected into every agent
          session. To change behavior, prefer adding a memory in the Memories tab.
        </p>
      )}

      {editing ? (
        <>
          {save.error && (
            <p className="text-sm text-red-500">{(save.error as Error).message}</p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="block min-h-0 w-full flex-1 resize-none rounded border bg-background p-3 font-mono text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </>
      ) : (
        <>
          {revert.error && (
            <p className="text-sm text-red-500">{(revert.error as Error).message}</p>
          )}
          <MarkdownDoc content={data.content} />
        </>
      )}
    </div>
  );
}
