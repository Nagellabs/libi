"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ManualInstructions, ManualStep } from "@/lib/agents/setup/types";

/** Interleaves a step's `text` with an inline `<code>` at the `{cmd}`
 *  placeholder — never `dangerouslySetInnerHTML`. */
function renderStepText(step: ManualStep): ReactNode {
  const placeholder = "{cmd}";
  const idx = step.text.indexOf(placeholder);
  if (!step.command || idx === -1) return step.text;

  const before = step.text.slice(0, idx);
  const after = step.text.slice(idx + placeholder.length);
  return (
    <>
      {before}
      <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground/90">
        {step.command}
      </code>
      {after}
    </>
  );
}

/**
 * The do-it-yourself route: always rendered next to the action button, never
 * behind a disclosure that starts closed (`AgentSetupCard` never wraps this
 * in something collapsed by default).
 */
export function ManualInstructionsBlock({
  steps,
  copyCommand,
  onCopy,
}: {
  steps: ManualInstructions;
  /** The command the Copy button puts on the clipboard — the REAL one libi
   *  would run, which may be a long absolute path. The steps show the short
   *  form; Copy hands over the exact line. */
  copyCommand: string;
  onCopy?: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyCommand);
    } catch {
      // Permission denied, or a non-secure context — the clipboard write
      // did not happen, so the label must not claim it did.
      return;
    }
    setCopied(true);
    onCopy?.();
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
      <span className="text-xs font-medium text-muted-foreground">
        Or do it yourself
      </span>
      <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        {steps.map((step, i) => (
          <li key={i}>{renderStepText(step)}</li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="cursor-pointer self-start"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
