/**
 * Whether a setup terminal is open, and a counter of its opens and closes that can be compared later.
 *
 * A setup terminal's command changes an agent's own config — an `mcp add`, an `mcp remove`, a provider sign-in —
 * and an agent reads that config only when a chat's session is created. The session manager pre-creates the next
 * chat (its standby), so it needs to know whether one overlapped a setup terminal
 * (`lib/sessions/standby-freshness.ts`). The terminal manager reports opens and closes here
 * (`lib/terminal/instance.ts`), so neither module imports the other.
 *
 * Kept on globalThis: in `next dev` a re-evaluated module would otherwise count from zero while terminals are open.
 */
interface SetupActivityState {
  epoch: number;
  live: number;
  settledListeners: Set<() => void>;
}

const g = globalThis as unknown as { __libiSetupActivity?: SetupActivityState };

function state(): SetupActivityState {
  g.__libiSetupActivity ??= { epoch: 0, live: 0, settledListeners: new Set() };
  return g.__libiSetupActivity;
}

export function noteSetupTerminalOpened(): void {
  const s = state();
  s.epoch++;
  s.live++;
}

export function noteSetupTerminalClosed(): void {
  const s = state();
  s.epoch++;
  s.live = Math.max(0, s.live - 1);
  if (s.live > 0) return;
  // Once the current call has finished: a surface's terminal is replaced by closing the old one and opening the next
  // in one call, which never leaves setup settled.
  queueMicrotask(() => {
    if (s.live > 0) return;
    for (const listener of [...s.settledListeners]) {
      try {
        listener();
      } catch {
        // A listener never breaks a terminal's teardown.
      }
    }
  });
}

export function setupActivity(): { epoch: number; live: number } {
  const s = state();
  return { epoch: s.epoch, live: s.live };
}

/** Called once no setup terminal is open any more. Returns the unsubscribe. */
export function onSetupTerminalsSettled(listener: () => void): () => void {
  const s = state();
  s.settledListeners.add(listener);
  return () => {
    s.settledListeners.delete(listener);
  };
}

/** Tests only: start counting from zero with no listeners. */
export function __resetSetupActivity(): void {
  g.__libiSetupActivity = undefined;
}
