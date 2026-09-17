"use client";

import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const OVERVIEW_KEY = "SKILL.md";

interface Props {
  prompts: { relPath: string }[];
  /** Currently selected file key: OVERVIEW_KEY or a prompt relPath. */
  selected: string;
  onSelect: (key: string) => void;
  /** When false, the add-prompt affordance is shown disabled with a reason. */
  canAddPrompt: boolean;
  addDisabledReason?: string;
  /** Called with the bare prompt name (no extension) to create a new prompt. */
  onAddPrompt: (name: string) => Promise<void>;
}

function fileLabel(relPath: string): string {
  return relPath.replace(/^prompts\//, "");
}

export function SkillFileSidebar({
  prompts,
  selected,
  onSelect,
  canAddPrompt,
  addDisabledReason,
  onAddPrompt,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAddPrompt(trimmed);
      setName("");
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function itemClasses(active: boolean) {
    return cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors cursor-pointer",
      active
        ? "bg-muted font-medium text-foreground"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
    );
  }

  return (
    <nav className="space-y-3" aria-label="Skill files">
      <button
        type="button"
        className={itemClasses(selected === OVERVIEW_KEY)}
        onClick={() => onSelect(OVERVIEW_KEY)}
      >
        <FileText className="size-3.5 shrink-0" />
        SKILL.md
      </button>

      <div className="space-y-1">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Prompts
        </p>
        {prompts.length === 0 && !adding && (
          <p className="px-2 text-xs text-muted-foreground/60 italic">— none —</p>
        )}
        <TooltipProvider delay={400}>
          {prompts.map((p) => (
            <Tooltip key={p.relPath}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={itemClasses(selected === p.relPath)}
                    onClick={() => onSelect(p.relPath)}
                  />
                }
              >
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{fileLabel(p.relPath)}</span>
              </TooltipTrigger>
              <TooltipContent side="right">{fileLabel(p.relPath)}</TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>

        {adding ? (
          <div className="space-y-1 px-1 pt-1">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                }
                if (e.key === "Escape") {
                  setAdding(false);
                  setName("");
                  setError(null);
                }
              }}
              placeholder="prompt-name"
              className="h-7 text-xs"
              disabled={busy}
            />
            {error && <p className="px-1 text-[11px] text-destructive">{error}</p>}
            <div className="flex gap-1">
              <Button
                size="sm"
                className="h-6 cursor-pointer px-2 text-xs"
                onClick={() => void commit()}
                disabled={busy || !name.trim()}
              >
                {busy ? "Adding…" : "Add"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 cursor-pointer px-2 text-xs"
                onClick={() => {
                  setAdding(false);
                  setName("");
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              canAddPrompt
                ? "cursor-pointer text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                : "cursor-not-allowed text-muted-foreground/50",
            )}
            onClick={() => canAddPrompt && setAdding(true)}
            disabled={!canAddPrompt}
            title={!canAddPrompt ? addDisabledReason : undefined}
          >
            <Plus className="size-3.5 shrink-0" />
            New prompt
          </button>
        )}
        {!canAddPrompt && addDisabledReason && !adding && (
          <p className="px-2 text-[11px] text-muted-foreground/60 italic">
            {addDisabledReason}
          </p>
        )}
      </div>
    </nav>
  );
}
