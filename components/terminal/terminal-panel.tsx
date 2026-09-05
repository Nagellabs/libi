"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Plus, TerminalSquare, X, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEditorState } from "@/lib/editor-state-context";
import { useTerminalFileDrop } from "@/hooks/terminal/use-terminal-file-drop";
import {
  useCreateTerminal,
  useTerminalSessions,
} from "@/lib/queries/terminals";
import { getPreset } from "@/lib/terminal/presets";
import {
  ONBOARDING_DEMO_PROMPT,
  TERMINAL_INSERT_TEXT_EVENT,
} from "@/lib/onboarding/demo";
import { toast } from "sonner";

// xterm touches DOM/WebGL at module scope — client-only.
const TerminalView = dynamic(() => import("./terminal-view"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full flex-col gap-2 p-3">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ),
});

/**
 * Occupies the chat-panel slot when the Terminal surface is active.
 * Shows the active terminal session, an empty state when none is
 * selected, and a "session ended" overlay (keeping the final screen)
 * when the shell exits while being viewed.
 */
export default function TerminalPanel() {
  const {
    activeTerminalId,
    setActiveTerminalId,
    terminalCliId,
    onboardingDemoOffer,
    setOnboardingDemoOffer,
  } = useEditorState();
  const { data: sessions, isLoading, isFetching } = useTerminalSessions();
  const createTerminal = useCreateTerminal();
  const [exited, setExited] = useState<{ id: string; exitCode: number } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const active = sessions?.find((s) => s.id === activeTerminalId) ?? null;
  const showExitedOverlay =
    activeTerminalId !== null && exited?.id === activeTerminalId;

  const { handleDrop, isUploading } = useTerminalFileDrop({
    // An exited terminal still mounts its view, but its PTY is gone — a paste
    // would go nowhere.
    hasLiveTerminal: active !== null && !showExitedOverlay,
  });

  /**
   * Drop handlers for every one of this component's roots.
   *
   * `preventDefault` runs on BOTH events and BEFORE any other decision: the
   * browser's default `dragover` action is to reject the drop target, and
   * without preventing it the `drop` event never fires at all — our handler
   * would simply never run. (It is NOT, as an earlier comment here claimed,
   * a defense against Electron navigating the window to the dropped file —
   * `electron/main.ts`'s `will-navigate` guard, backed by `nav-guard.ts`,
   * already blocks any off-origin navigation including `file:`. The call is
   * still required, just for the ordinary DOM reason above.) That is also
   * why the no-terminal case is intercepted here rather than left to the
   * browser — the hook then explains what to do instead of the drop
   * silently doing nothing.
   */
  const dropProps = {
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      // Snapshot synchronously — `dataTransfer` is bound to the drop event
      // and is not readable once the handler returns.
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0 && (e.dataTransfer?.types.length ?? 0) > 0) {
        // The panel advertises as a drop target for ANY drag (dragover
        // always cancels), including the Resources panel's own in-app asset
        // drags (`application/libi-file-id` / `x-libi-asset`), which carry
        // no `dataTransfer.files`. Without this, dragging something onto the
        // terminal that the user can plainly see produces total silence.
        // The hook only ever sees real `File[]`, so its "no files → return"
        // is untouched — this decision has to live here, where `types` is
        // visible.
        toast.info("Only files can be dropped on the terminal.");
        return;
      }
      void handleDrop(files);
    },
  };

  // Selection maintenance. Two cases, carefully separated:
  //  1. Nothing selected → pick the most recent terminal (page load, return
  //     from an ACP surface, after a close).
  //  2. Selected id is GONE from a settled list → fall back. The isFetching
  //     guard is load-bearing: right after a create, setActiveTerminalId(new)
  //     runs while the list cache is still stale (refetch in flight) — acting
  //     on that stale list would stomp the user's brand-new terminal back to
  //     the previous one (QA-found race).
  useEffect(() => {
    if (!sessions || isLoading || isFetching) return;
    if (exited?.id === activeTerminalId) return; // keep final screen + overlay
    if (activeTerminalId === null) {
      if (sessions.length > 0) setActiveTerminalId(sessions[0].id);
      return;
    }
    if (!sessions.some((s) => s.id === activeTerminalId)) {
      setActiveTerminalId(sessions.length > 0 ? sessions[0].id : null);
    }
  }, [activeTerminalId, exited, sessions, isLoading, isFetching, setActiveTerminalId]);

  const handleNewTerminal = async () => {
    try {
      const meta = await createTerminal.mutateAsync(terminalCliId);
      setExited(null);
      setActiveTerminalId(meta.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open terminal");
    }
  };

  // First-run demo offer for the Terminal surface. Unlike the chat surface
  // (which sends the prompt straight to the ACP agent), a terminal needs a
  // coding-agent CLI running at a text prompt before the demo prompt is useful.
  // To de-risk that, the chip offers two paths:
  //   • Copy prompt  — always works; the user pastes it into their agent.
  //   • Inject prompt — convenience; pastes it into the live terminal for them.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copyDemoPrompt = async () => {
    try {
      await navigator.clipboard.writeText(ONBOARDING_DEMO_PROMPT);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select and copy the prompt manually.");
    }
  };

  const injectDemoPrompt = () => {
    if (!active) {
      void handleNewTerminal();
      return;
    }
    window.dispatchEvent(
      new CustomEvent(TERMINAL_INSERT_TEXT_EVENT, {
        detail: { text: ONBOARDING_DEMO_PROMPT },
      }),
    );
    setOnboardingDemoOffer(false);
  };

  const demoChip = onboardingDemoOffer ? (
    <div className="relative m-3 w-full max-w-md shrink-0 rounded-2xl border border-primary/30 bg-[color:var(--accent-soft)] p-4 shadow-sm">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setOnboardingDemoOffer(false)}
        className="absolute right-2.5 top-2.5 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </button>
      <div className="flex flex-col gap-1 pr-6">
        <span className="text-sm font-semibold text-foreground">
          You&apos;re all set! 🎬
        </span>
        <span className="text-[13px] leading-relaxed text-muted-foreground">
          Want a quick tour? I&apos;ll build a short example video — copy or inject
          the demo prompt into your coding agent.
        </span>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={copyDemoPrompt}
          className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition active:scale-[0.99] ${
            copied
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
              : "border-border bg-background/40 text-foreground hover:bg-accent"
          }`}
        >
          {copied ? (
            <>
              <Check className="size-4 animate-in zoom-in-50 duration-200" strokeWidth={2.5} />
              Copied!
            </>
          ) : (
            <>
              <Copy className="size-4" strokeWidth={2.2} />
              Copy prompt
            </>
          )}
        </button>
        <button
          type="button"
          onClick={injectDemoPrompt}
          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-[0.99]"
        >
          <TerminalSquare className="size-4" strokeWidth={2.2} />
          {active ? "Inject prompt" : "Open a terminal"}
        </button>
      </div>
    </div>
  ) : null;

  // Empty state — no session selected and none to auto-select.
  if (!activeTerminalId || (!active && !showExitedOverlay)) {
    return (
      <div className="flex h-full flex-col bg-surface" {...dropProps}>
        {demoChip}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          {isLoading ? (
            <Skeleton className="h-8 w-48" />
          ) : (
            <>
              <div className="grid size-16 place-items-center rounded-2xl bg-[color:var(--accent-soft)]">
                <TerminalSquare className="size-7 text-primary" strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="font-brand text-xl font-semibold text-foreground">
                  No terminal open
                </h2>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                  Open a terminal rooted in the libi workspace — your CLI agent
                  will find libi&apos;s tools automatically.
                </p>
              </div>
              <Button
                className="cursor-pointer"
                onClick={handleNewTerminal}
                disabled={createTerminal.isPending}
              >
                <Plus className="mr-2 h-4 w-4" strokeWidth={2.2} />
                New terminal
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const title = active?.title ?? "Terminal";
  const preset = active ? getPreset(active.cliId) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" {...dropProps}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <TerminalSquare className="size-3.5 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
        {preset && preset.id !== "shell" ? (
          <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">
            {preset.label}
          </span>
        ) : null}
        {isUploading ? (
          <span
            data-testid="terminal-drop-uploading"
            className="ml-auto animate-pulse text-[11px] text-muted-foreground"
          >
            Uploading…
          </span>
        ) : null}
      </div>

      {active?.cliId === "shell" ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/20 px-3 py-2 text-[12px] leading-snug text-muted-foreground">
          <TerminalSquare className="mt-0.5 size-3.5 shrink-0 opacity-60" />
          <span>
            Plain shell — start a coding agent (Claude Code, Codex, …) to work
            with the libi editor.
          </span>
        </div>
      ) : null}

      {demoChip}

      <div className="relative min-h-0 flex-1">
        <TerminalView
          key={activeTerminalId}
          terminalId={activeTerminalId}
          onExited={(exitCode) =>
            setExited({ id: activeTerminalId, exitCode })
          }
        />
        {showExitedOverlay ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
            <span className="text-sm text-muted-foreground">
              Session ended
              {exited && exited.exitCode !== 0 ? ` (exit code ${exited.exitCode})` : ""}
            </span>
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={handleNewTerminal}
              disabled={createTerminal.isPending}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" strokeWidth={2.2} />
              New terminal
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
