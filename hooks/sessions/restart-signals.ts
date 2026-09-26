/**
 * The window's own half of "Restart session": which restarts THIS window asked for and has not
 * heard back on, and their outcome once the request settles. `useRestartSession` writes it;
 * `useAgentChat` reads it, so a chat stuck waiting on a `session-restart` SSE event that never
 * reached this window (an SSE reconnect, a laptop asleep through the stuck path, a dev-server
 * singleton swap) still ends its wait when the request itself answers.
 */

export type RestartOutcome = { ok: true } | { ok: false; error: string };
type SettledListener = (sessionId: string, outcome: RestartOutcome) => void;

const requested = new Set<string>();
const listeners = new Set<SettledListener>();

export const restartSignals = {
  /** This window has sent a restart for `sessionId`. */
  requested(sessionId: string): void {
    requested.add(sessionId);
  },
  /** The request for `sessionId` answered (or failed to reach the server). */
  settled(sessionId: string, outcome: RestartOutcome): void {
    requested.delete(sessionId);
    for (const listener of [...listeners]) listener(sessionId, outcome);
  },
  /** Whether this window still waits on its own restart request for `sessionId`. */
  isRequested(sessionId: string): boolean {
    return requested.has(sessionId);
  },
  onSettled(listener: SettledListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
