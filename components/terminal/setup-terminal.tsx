"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import TerminalView from "@/components/terminal/terminal-view";
import { Button } from "@/components/ui/button";
import type { SetupSurface } from "@/lib/terminal/types";
import { useSetupTerminalHost, type SetupTerminalEntry } from "@/components/agents-page/setup-terminal-host";

function statusText(entry: SetupTerminalEntry): string {
  if (entry.exited) return `Finished${entry.exitCode ? ` (exit code ${entry.exitCode})` : ""}. You can close this.`;
  if (entry.gone) return "This terminal was closed after being idle. Run the step again to open a new one.";
  if (entry.submitted) return "Running. Follow what it asks in the terminal.";
  return "Read the command, then press Enter in the terminal to run it.";
}

/** How long after the terminal takes the keyboard, or the command appears at its prompt, an Enter is not taken. */
export const SETUP_ENTER_GUARD_MS = 500;

/**
 * Keeps a stray Enter from running the command the terminal has just typed at its prompt. The terminal takes the
 * keyboard as it opens, so the Enter that clicked the button (from the keyboard), or one held down and repeating,
 * would otherwise land in the shell and run a command the user never read. Until the command is submitted, an Enter
 * within `SETUP_ENTER_GUARD_MS` of the terminal taking focus or of output reaching its screen is dropped; a
 * repeating Enter (a held key) is dropped always. Every other key passes.
 */
export function createEnterGuard(now: () => number = () => performance.now(), alreadySubmitted = false) {
  let armedAt = now();
  let submitted = alreadySubmitted;
  return {
    /** The terminal took the keyboard, or the command (or anything else) was printed at the prompt. */
    arm(): void {
      if (!submitted) armedAt = now();
    },
    /** The waiting command was run: from here on only a repeating Enter is dropped. */
    markSubmitted(): void {
      submitted = true;
    },
    accepts(ev: Pick<KeyboardEvent, "key" | "repeat">): boolean {
      if (ev.key !== "Enter") return true;
      if (ev.repeat) return false;
      return submitted || now() - armedAt >= SETUP_ENTER_GUARD_MS;
    },
  };
}

type GuardSlot = { id: string; guard: ReturnType<typeof createEnterGuard> };

/**
 * One guard per terminal: a new terminal (a new command) starts guarded again. A terminal whose command was already
 * submitted (the view remounted after a tab switch) starts unguarded: the script may be waiting for an answer, such
 * as the redirect URL `mcp login` asks to be pasted, and its Enter must go through.
 */
function guardFor(ref: { current: GuardSlot | null }, id: string, submitted: boolean): ReturnType<typeof createEnterGuard> {
  if (ref.current?.id !== id) ref.current = { id, guard: createEnterGuard(undefined, submitted) };
  else if (submitted) ref.current.guard.markSubmitted();
  return ref.current.guard;
}

/**
 * The terminals already brought to the user, by id. A tab switch remounts this component for the same terminal, and
 * that must not yank the page back to it; a new terminal (a new id) is brought into view once.
 */
const revealed = new Set<string>();

/**
 * The ONLY place a setup command is shown. The command is already waiting at
 * the prompt of the PTY (typed at spawn, never followed by Enter) — this
 * renders that PTY and tells the user what to do with it. xterm draws to a
 * canvas, so the command and action are mirrored onto data attributes for
 * tests; nothing else displays them.
 *
 * A terminal the server has already closed (reaped while its tab was hidden)
 * has nothing left to show, so only the explanation and Close remain.
 */
export function SetupTerminal({ surface }: { surface: SetupSurface }) {
  const host = useSetupTerminalHost();
  const entry = host.terminals[surface];
  const rootRef = useRef<HTMLDivElement>(null);
  const revealId = entry && !entry.exited && !entry.gone && !entry.submitted ? entry.id : null;
  const guardRef = useRef<GuardSlot | null>(null);

  // A newly opened terminal is where the user has to act next (press Enter), but it may open below the card whose
  // button opened it, off screen. Bring it into view and put the keyboard in it, so Enter runs the command at once.
  // (Owner-reported 2026-09-25: "nothing happens" after Sign in; the command was waiting, unseen.)
  useEffect(() => {
    const root = rootRef.current;
    if (!revealId || !root || revealed.has(revealId)) return;
    revealed.add(revealId);
    root.scrollIntoView?.({ block: "center", behavior: "smooth" });
    // xterm keeps keyboard input in a helper textarea; focusing it is what `term.focus()` does.
    root.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus({ preventScroll: true });
    guardFor(guardRef, revealId, false).arm();
  }, [revealId]);

  if (!entry) return null;
  const terminalId = entry.id;
  const submitted = entry.submitted;
  // Claude Code's sign-in runs its full-screen interface, which needs the room.
  const tall = entry.action === "sign-in" && entry.anchor === "claude-code";
  return (
    <div
      ref={rootRef}
      data-testid={`setup-terminal-${surface}`}
      data-command={entry.command}
      data-action={entry.action}
      className="overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className={`space-y-1 px-3 py-1.5 text-xs ${entry.gone ? "" : "border-b border-border"}`}>
        <div className="flex min-h-7 items-center justify-between gap-2">
          <span className="text-muted-foreground">{statusText(entry)}</span>
          <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => void host.close(surface)}>
            <X className="size-3.5" />
            Close
          </Button>
        </div>
        {entry.explanation ? (
          <p data-testid="setup-terminal-explanation" className="max-w-prose pb-1 leading-relaxed text-foreground/80">
            {entry.explanation}
          </p>
        ) : null}
        {entry.scripts?.length ? (
          <div data-testid="setup-terminal-scripts" className="flex flex-wrap gap-x-3 gap-y-1 pb-1">
            {entry.scripts.map((script) => (
              // A new tab in a browser; the desktop app hands a new-window link to the system browser.
              <a
                key={script.name}
                href={script.url}
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                View {script.name}
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {entry.gone ? null : (
        <div data-testid="setup-terminal-frame" className={tall ? "h-[32rem]" : "h-64"}>
          <TerminalView
            key={terminalId}
            terminalId={terminalId}
            onExited={(code) => host.markExited(surface, terminalId, code)}
            onSessionGone={() => host.markGone(surface, terminalId)}
            onSubmit={() => {
              guardFor(guardRef, terminalId, true).markSubmitted();
              host.markSubmitted(surface, terminalId);
            }}
            keyFilter={(ev) => guardFor(guardRef, terminalId, submitted).accepts(ev)}
            onOutput={() => guardFor(guardRef, terminalId, submitted).arm()}
          />
        </div>
      )}
    </div>
  );
}
