"use client";

import { FolderOpen } from "lucide-react";
import {
  revealFile,
  revealFileById,
  revealLabel,
  getShellPlatform,
} from "@/lib/shell/client";
import { trackEvent } from "@/lib/analytics/client";

/**
 * Which surface offered the reveal. Declared here rather than at each call
 * site so the analytics enum has one home — `lib/analytics/events.ts` documents
 * the same three values against the `asset_revealed` event.
 */
export type RevealSource = "context_menu" | "summary_tab" | "asset_grid";

/**
 * The reveal action, shared by every surface that offers it.
 *
 * Two entry points because the surfaces genuinely differ: the two context
 * menus know only a file id, while the Summary tab's Location row already
 * holds the resolved path and would otherwise re-fetch it. Both report the
 * same event, so a new surface cannot forget to.
 */
export function useRevealAsset(source: RevealSource) {
  const label = revealLabel(getShellPlatform());

  const revealById = (fileId: string) => {
    trackEvent("asset_revealed", { source });
    void revealFileById(fileId);
  };

  const revealByPath = (path: string) => {
    trackEvent("asset_revealed", { source });
    // revealFile rejects if the bridge call or the HTTP fallback fails, and
    // the caller is a click with nowhere to surface an error — reveal is
    // fire-and-forget by design.
    void revealFile(path).catch(() => {});
  };

  return { revealById, revealByPath, label };
}

/**
 * The reveal row for a context menu.
 *
 * This component exists because the Assets grid shipped WITHOUT a reveal item
 * while the resources sidebar had one: each menu carried its own hand-rolled
 * copy, so adding a surface meant remembering to duplicate it. A menu that
 * lists assets now renders this and gets the action, the platform-native
 * wording and the analytics event together.
 *
 * `onAfter` closes the host's menu — menus own their own open state, and the
 * item should not reach into it.
 */
export function RevealMenuItem({
  fileId,
  source,
  onAfter,
}: {
  fileId: string;
  source: RevealSource;
  onAfter?: () => void;
}) {
  const { revealById, label } = useRevealAsset(source);

  return (
    <button
      type="button"
      data-testid="reveal-menu-item"
      onClick={() => {
        onAfter?.();
        revealById(fileId);
      }}
      className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
    >
      <FolderOpen className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
