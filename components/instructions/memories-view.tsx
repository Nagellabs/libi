"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useMemories, useUpdateMemories } from "@/lib/queries/instructions";
import { MarkdownDoc } from "./markdown-doc";

const MAX = 8000;

const STARTER = `## My preferences

- `;

interface Props {
  /** Lets the page shell switch to a full-height (non-scrolling) layout while editing. */
  onEditingChange?: (editing: boolean) => void;
}

export function MemoriesView({ onEditingChange }: Props) {
  const { data, isLoading } = useMemories();
  const update = useUpdateMemories();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const setEditMode = (value: boolean) => {
    setEditing(value);
    onEditingChange?.(value);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (data && !editing) setText(data.content);
  }, [data, editing]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const content = data?.content ?? "";
  const tooLong = text.length > MAX;

  if (!editing && content.trim().length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-8">
        <h2 className="text-lg font-semibold">No memories yet</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Memories are things you or the agent saved so future sessions behave the way you
          like — pinned providers, style rules, pacing preferences. They are injected at the
          bottom of the agent&apos;s instructions in every session. Ask the agent to
          &quot;remember&quot; something, or write them here yourself.
        </p>
        <Button
          size="sm"
          className="cursor-pointer"
          onClick={() => {
            setText(STARTER);
            setEditMode(true);
          }}
        >
          Create memories
        </Button>
      </div>
    );
  }

  return (
    <div className={editing ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Memories</h2>
        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <span className={`text-xs ${tooLong ? "text-red-500" : "text-muted-foreground"}`}>
                {text.length} / {MAX} chars
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="cursor-pointer"
                onClick={() => {
                  setText(content);
                  setEditMode(false);
                }}
              >
                Cancel
              </Button>
              <AlertDialog key="save-confirm" open={confirmOpen} onOpenChange={setConfirmOpen}>
                <AlertDialogTrigger
                  render={<Button size="sm" className="cursor-pointer" />}
                  disabled={tooLong || update.isPending}
                >
                  {update.isPending ? "Saving…" : "Save"}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Save memories?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Saving will <strong>terminate all running agent sessions</strong> so the
                      change takes effect immediately. Any in-flight tool calls will be lost.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="cursor-pointer"
                      onClick={() => {
                        update.mutate(text, {
                          onSuccess: () => {
                            setConfirmOpen(false);
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
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer"
                onClick={() => setEditMode(true)}
              >
                Edit
              </Button>
            </>
          )}
        </div>
      </div>

      {update.error && (
        <p className="text-sm text-red-500">{(update.error as Error).message}</p>
      )}

      {editing ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="block min-h-0 w-full flex-1 resize-none rounded border bg-background p-3 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="## My preferences&#10;&#10;- Always use ElevenLabs for STT"
        />
      ) : (
        <MarkdownDoc content={content} />
      )}
    </div>
  );
}
