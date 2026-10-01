// electron/quit-shutdown.ts
//
// Electron's quit runs libi's shutdown, and SIGINT/SIGTERM quit through
// Electron (EL-2; the runtime half is lib/server/lifecycle/quit.ts).
//
// Before this, the packaged app had it both ways wrong. The runtime's Category B
// put SIGTERM/SIGINT listeners on this process after `ready`, and a Node listener
// REPLACES Electron's own graceful quit on that signal: libi's shutdown ran, but
// Chromium's teardown, `before-quit` and `will-quit` did not. And a normal quit
// (Cmd-Q, the last window closed) ran none of libi's shutdown — the MCP HTTP
// child, the export driver and the agent processes were left to die with the
// process; only the port file was cleaned, synchronously, on `exit`.
//
// Now the shell tells a runtime that has the hook that it owns those signals
// (`claimQuitSignalsIfSupported`, before the server starts), and `before-quit`
// holds the quit ONCE, awaits the runtime's `shutdownForQuit()` under
// QUIT_SHUTDOWN_BOUND_MS, then quits again — which goes through. A runtime
// without the hook (older), or none at all (dev, where Next runs in its own
// process), is never held: it quits exactly as before.

export const QUIT_SHUTDOWN_BOUND_MS = 10_000;

/** The slice of `runtime.api` this needs. Both are optional: older runtimes lack them. */
export interface QuitShutdownApi {
  claimQuitSignals?: () => void;
  shutdownForQuit?: () => Promise<unknown>;
}

type Log = (line: string) => void;

/** Tell the runtime the shell owns SIGINT/SIGTERM — only when it can also run the shutdown on quit. */
export function claimQuitSignalsIfSupported(api: QuitShutdownApi | null | undefined, log: Log): boolean {
  if (typeof api?.claimQuitSignals !== "function" || typeof api?.shutdownForQuit !== "function") {
    log("quit: runtime predates shutdownForQuit — it keeps its own SIGINT/SIGTERM listeners");
    return false;
  }
  api.claimQuitSignals();
  log("quit: SIGINT/SIGTERM quit through Electron; before-quit runs libi's shutdown");
  return true;
}

interface QuitApp {
  on(event: "before-quit", listener: (e: { preventDefault: () => void }) => void): unknown;
  quit(): void;
}

export function installQuitShutdown(
  app: QuitApp,
  getApi: () => QuitShutdownApi | null | undefined,
  log: Log,
  boundMs: number = QUIT_SHUTDOWN_BOUND_MS,
): void {
  let state: "idle" | "running" | "done" = "idle";
  app.on("before-quit", (e) => {
    log("app before-quit");
    if (state === "done") return;
    const api = getApi();
    if (typeof api?.shutdownForQuit !== "function") return;
    // Held until libi's shutdown settles (or the bound passes); every quit
    // asked for meanwhile is held too and folds into the one below.
    e.preventDefault();
    if (state === "running") return;
    state = "running";
    const started = Date.now();
    log("quit: running libi's shutdown before quitting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundMs);
    });
    let shutdown: Promise<"done">;
    try {
      shutdown = Promise.resolve(api.shutdownForQuit()).then(() => "done" as const);
    } catch (err) {
      shutdown = Promise.reject(err);
    }
    Promise.race([shutdown, bound])
      .then(
        (outcome) =>
          log(
            outcome === "timeout"
              ? `quit: libi's shutdown did not finish within ${boundMs}ms — quitting anyway`
              : `quit: libi's shutdown finished in ${Date.now() - started}ms`,
          ),
        (err: unknown) =>
          log(`quit: libi's shutdown threw: ${err instanceof Error ? err.message : String(err)} — quitting anyway`),
      )
      .finally(() => {
        clearTimeout(timer);
        state = "done";
        app.quit();
      });
  });
}
