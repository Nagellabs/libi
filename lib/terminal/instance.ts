import { invalidateAgentCliMemo } from "@/lib/agents/cli/resolve";
import { __clearLibiRegistrationMemo } from "@/lib/agents/libi-registration";
import { getLibiAgentDir } from "@/lib/libi-home";
import { __clearProviderMemo } from "@/lib/providers/detect";
import { endClaudeLoginsOf, noteClaudeLoginEnded, noteClaudeLoginStarted } from "@/lib/providers/claude-signin-probe";
import { createSignInMarkerReader, type SignInMarker } from "@/lib/providers/sign-in-markers";
import { serverLogger as logger } from "@/lib/logger";
import { TerminalManager } from "./manager";
import { realPtyFactory } from "./pty";
import { noteSetupTerminalClosed, noteSetupTerminalOpened } from "./setup-activity";
import type { SetupSurface } from "./types";

/**
 * globalThis singleton — in `next dev`, route-handler modules are
 * re-evaluated on edit; a module-level instance would be silently
 * replaced, orphaning live PTYs (same class of bug as the SessionManager
 * / JobManager singletons guard against).
 *
 * PTYs spawn rooted at the agent workspace (`~/.libi/agent/`), which
 * already holds CLAUDE.md / AGENTS.md / .claude/settings.local.json — so
 * any CLI launched in a terminal discovers libi's MCP tools exactly like
 * the documented "Bring Your Own CLI" mode.
 */
/** How often the setup-terminal reaper checks for idle terminals. */
const SETUP_TERMINAL_SWEEP_MS = 60_000;

/**
 * A setup terminal went away: whatever it installed, updated or registered — in
 * ANY surface — must show on the next poll, so drop the CLI memo, the
 * libi-registration memo (a `claude mcp add libi` run there shows at once) and
 * the provider-detection memo (so does a provider `mcp add` / `mcp remove`).
 * It also records that the terminal closed, so a pre-created chat that
 * overlapped it is not handed out (`./setup-activity`).
 * Each step is guarded on its own, so one failing never skips another.
 *
 * Never throws. It runs synchronously inside `TerminalManager.destroy`, which is
 * reached from `create`'s per-surface replacement (a throw would fail the POST
 * after the previous terminal was already killed), from `pty.onExit`, and from
 * the reaper interval (a throw inside a timer).
 */
export function handleSetupTerminalExit(_surface?: SetupSurface, id?: string): void {
  if (id !== undefined) {
    markerReaders.delete(id);
    try {
      endClaudeLoginsOf(id);
    } catch {
      logger.warn({ tag: "terminal", op: "setup_exit_hook_failed" }, "could not end the sign-ins a setup terminal was running");
    }
  }
  try {
    noteSetupTerminalClosed();
  } catch {
    logger.warn(
      { tag: "terminal", op: "setup_exit_hook_failed" },
      "could not record that a setup terminal closed",
    );
  }
  try {
    invalidateAgentCliMemo();
  } catch {
    logger.warn(
      { tag: "terminal", op: "setup_exit_hook_failed" },
      "could not invalidate the agent CLI memo after a setup terminal exited",
    );
  }
  try {
    __clearLibiRegistrationMemo();
  } catch {
    logger.warn(
      { tag: "terminal", op: "setup_exit_hook_failed" },
      "could not clear the libi registration memo after a setup terminal exited",
    );
  }
  try {
    __clearProviderMemo();
  } catch {
    logger.warn(
      { tag: "terminal", op: "setup_exit_hook_failed" },
      "could not clear the provider detection memo after a setup terminal exited",
    );
  }
}

/** One marker reader per live setup terminal (`lib/providers/sign-in-markers.ts`). */
const markerReaders = new Map<string, (chunk: string) => SignInMarker[]>();

/**
 * A setup terminal printed something. libi's setup scripts announce where Claude Code's `mcp login` starts and
 * ends, and Claude Code must not be asked about that entry in between (`lib/providers/claude-signin-probe.ts`).
 * Never throws: it runs inside the PTY's data handler.
 */
export function handleSetupTerminalOutput(id: string, data: string): void {
  try {
    let read = markerReaders.get(id);
    if (!read) {
      read = createSignInMarkerReader();
      markerReaders.set(id, read);
    }
    for (const marker of read(data)) {
      if (marker.phase === "start") noteClaudeLoginStarted(marker.entry, id);
      else noteClaudeLoginEnded(marker.entry);
      logger.info(
        { tag: "providers", op: `claude_signin_${marker.phase}`, entry: marker.entry, terminal: id },
        marker.phase === "start" ? "a setup terminal's Claude Code sign-in started" : "a setup terminal's Claude Code sign-in ended",
      );
    }
  } catch {
    logger.warn({ tag: "terminal", op: "setup_output_hook_failed" }, "could not read a setup terminal's output for sign-in markers");
  }
}

const g = globalThis as unknown as { __libiTerminalManager?: TerminalManager };

export function getTerminalManager(): TerminalManager {
  if (!g.__libiTerminalManager) {
    g.__libiTerminalManager = new TerminalManager(realPtyFactory, {
      cwd: () => getLibiAgentDir(),
      onSetupTerminalOpen: noteSetupTerminalOpened,
      onSetupTerminalExit: handleSetupTerminalExit,
      onSetupTerminalOutput: handleSetupTerminalOutput,
    });
    // Reap abandoned setup terminals. Started inside this block so a dev
    // re-evaluation of the module cannot stack a second interval; unref'd so
    // it never holds the process open.
    setInterval(() => {
      g.__libiTerminalManager?.sweepIdleSetupTerminals();
    }, SETUP_TERMINAL_SWEEP_MS).unref();
  }
  return g.__libiTerminalManager;
}
