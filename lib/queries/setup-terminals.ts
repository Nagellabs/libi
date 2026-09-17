import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { SetupSurface, TerminalSessionMeta } from "@/lib/terminal/types";
import { agentStatusKeys } from "./agent-status";
import { libiRegistrationKeys } from "./libi-registration";
import { providerKeys } from "./providers";
import { terminalKeys } from "./terminals";

/**
 * A setup terminal is a FRESH `purpose: "setup"` shell carrying exactly one
 * command as spawn-time `initialInput`. The server closes the surface's
 * previous setup terminal when this one is created, so the client never sends
 * a second command into a shell whose foreground process it cannot see.
 */
/**
 * How long opening a setup terminal may take before it is given up on. The
 * Agents page sends one surface's opens one at a time, so a create request
 * that never answers would otherwise hold every later open on that surface
 * until the page is left.
 */
export const OPEN_SETUP_TERMINAL_TIMEOUT_MS = 15_000;

export function useOpenSetupTerminal(): UseMutationResult<
  TerminalSessionMeta,
  Error,
  { surface: SetupSurface; command: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ surface, command }) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Aborts the request AND rejects on its own: the bound must hold even
      // for a request that does not settle once aborted.
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Opening the terminal timed out. Try again."));
        }, OPEN_SETUP_TERMINAL_TIMEOUT_MS);
      });
      const create = async (): Promise<TerminalSessionMeta> => {
        const res = await fetch("/api/terminal/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cliId: "shell", purpose: "setup", surface, initialInput: command }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as TerminalSessionMeta;
      };
      return Promise.race([create(), timedOut]).finally(() => clearTimeout(timer));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: terminalKeys.all });
    },
  });
}

export function useCloseSetupTerminal(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/terminal/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      // 404: already gone (the PTY exited, the reaper or a replacement closed it).
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    },
    // Closing a setup terminal drops the server's CLI, libi-registration and
    // provider-detection memos (the same hook as a shell exit), so whatever the
    // command changed is readable now — and only now, once the DELETE has
    // landed. Re-read them here rather than when the terminal leaves the
    // screen: that happens before the DELETE is sent, and a read that beat it
    // would get the old memo back. The install-job queries share the status
    // prefix but not its memo; the legacy-key notices share the providers
    // prefix but are not detection.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: terminalKeys.all });
      void qc.invalidateQueries({ queryKey: libiRegistrationKeys.all });
      void qc.invalidateQueries({ queryKey: providerKeys.all, exact: true });
      void qc.invalidateQueries({
        queryKey: agentStatusKeys.all,
        predicate: (query) => query.queryKey[1] !== "install",
      });
    },
  });
}

/**
 * Delete a setup terminal while the page is going away. `navigator.sendBeacon`
 * can only POST, so this is a `keepalive` fetch DELETE — the browser lets it
 * finish after the page is gone. Fire-and-forget by construction; if it never
 * lands, the server's idle reaper closes the terminal.
 */
export function closeSetupTerminalOnLeave(id: string): void {
  try {
    void fetch(`/api/terminal/sessions/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(
      () => undefined,
    );
  } catch {
    /* no fetch available (server render) — nothing to delete */
  }
}
