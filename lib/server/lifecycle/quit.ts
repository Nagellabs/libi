// lib/server/lifecycle/quit.ts
//
// The desktop shell's quit and libi's shutdown, joined (EL-2).
//
// Inside Electron's main process a Node signal listener added after `ready`
// REPLACES Electron's own graceful quit on that signal: libi's shutdown ran on
// SIGTERM/SIGINT, but Chromium's teardown, `before-quit` and `will-quit` never
// did. The other way round was broken too: an Electron quit (Cmd-Q, the last
// window closed) ran none of libi's shutdown — only Category B's synchronous
// `exit` cleanup of the port file.
//
// So a shell that knows this contract:
//   1. calls `claimQuitSignals()` BEFORE the server starts, and Category B then
//      installs no SIGINT/SIGTERM listener (`shutdownSignals`): a signal reaches
//      Electron, which quits;
//   2. calls `shutdownForQuit()` from `before-quit` (holding the quit until it
//      settles, under a bound — electron/quit-shutdown.ts).
// A shell that predates it never claims, and plain Node (npx) is not Electron:
// both keep exactly today's listeners.
//
// Both slots live on `globalThis`, not in module variables: the shell loads the
// compiled `dist-cli` copy of this module through `shell-api`, while Category B
// runs inside Next's own bundle with its own copy (the split
// lib/server/lifecycle/relaunch.ts documents).

type Shutdown = (trigger: string) => Promise<void>;

const slot = globalThis as unknown as {
  __libiQuitShutdown?: Shutdown | null;
  __libiShellOwnsQuitSignals?: boolean;
};

/** Category B hands over the one shutdown it runs for a signal. */
export function registerQuitShutdown(fn: Shutdown): void {
  slot.__libiQuitShutdown = fn;
}

/**
 * The desktop shell owns SIGINT/SIGTERM: they go through Electron's quit, whose
 * `before-quit` calls `shutdownForQuit()`. Call before the server starts —
 * Category B reads it when it installs its listeners.
 */
export function claimQuitSignals(): void {
  slot.__libiShellOwnsQuitSignals = true;
}

export function shellOwnsQuitSignals(): boolean {
  return slot.__libiShellOwnsQuitSignals === true;
}

/**
 * Run libi's orderly shutdown (agent processes retired, the export driver and
 * the MCP HTTP child stopped, port files removed) WITHOUT exiting: Electron
 * ends the process once its quit completes. Idempotent, and shared with the
 * signal path. Resolves false when there was nothing to shut down yet (a quit
 * before the server's Category B ran).
 */
export async function shutdownForQuit(): Promise<boolean> {
  const fn = slot.__libiQuitShutdown;
  if (typeof fn !== "function") return false;
  await fn("quit");
  return true;
}
