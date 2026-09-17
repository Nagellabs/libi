"use client";

import { X } from "lucide-react";
import TerminalView from "@/components/terminal/terminal-view";
import { Button } from "@/components/ui/button";
import type { SetupSurface } from "@/lib/terminal/types";
import { useSetupTerminalHost, type SetupTerminalEntry } from "@/components/agents-page/setup-terminal-host";

function statusText(entry: SetupTerminalEntry): string {
  if (entry.exited) return `Finished${entry.exitCode ? ` (exit code ${entry.exitCode})` : ""}. You can close this.`;
  if (entry.gone) return "This terminal was closed after being idle. Run the step again to open a new one.";
  return "Read the command, then press Enter in the terminal to run it.";
}

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
  if (!entry) return null;
  const terminalId = entry.id;
  // Claude Code's sign-in runs its full-screen interface, which needs the room.
  const tall = entry.action === "sign-in" && entry.anchor === "claude-code";
  return (
    <div
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
          />
        </div>
      )}
    </div>
  );
}
