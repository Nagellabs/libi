"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useEditorState } from "@/lib/editor-state-context";
import { useCodexConnect } from "@/lib/queries/codex-connect";

/**
 * One-line dismissible nudge shown the first time the user selects Codex — as
 * the in-app agent OR as the terminal launch preset — pointing them at the
 * "Install" button so libi's tools show up in codex (their own terminal, the
 * Codex app, and libi's built-in Terminal).
 *
 * Hidden when codex isn't on PATH (`available:false`), once libi is already
 * installed into codex, or once dismissed.
 */
export function CodexConnectNudge() {
  const {
    activeProviderId,
    terminalCliId,
    codexNudgeDismissed,
    setCodexNudgeDismissed,
  } = useEditorState();
  const { data } = useCodexConnect();

  const codexSelected =
    activeProviderId === "codex" ||
    (activeProviderId === "terminal" && terminalCliId === "codex");

  // `available` = codex CLI on PATH. Nudge only when libi isn't installed yet.
  const available = data?.available ?? false;
  const installed = data?.installed ?? false;

  if (!codexSelected || !available || installed || codexNudgeDismissed) {
    return null;
  }

  return (
    <div className="mx-2 mb-1 flex items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[11px] leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden">
      <span className="min-w-0 flex-1">
        Want libi&apos;s tools in codex (your terminal or the Codex app)?{" "}
        <Link
          href="/mcps-skills?tab=mcp"
          className="cursor-pointer font-medium text-primary hover:underline"
        >
          → Install
        </Link>
      </span>
      <button
        type="button"
        onClick={() => setCodexNudgeDismissed(true)}
        aria-label="Dismiss"
        className="cursor-pointer flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
