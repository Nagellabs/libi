import { getSettings } from "@/lib/db/settings";

/**
 * Whether the "Terminal" surface is the user's active agent selection.
 *
 * The terminal is a pseudo-provider: it never touches SessionManager /
 * ACP. SessionManager._activeAgentId keeps tracking the last warmed ACP
 * agent, and this flag overrides what `/api/sessions` reports as
 * `activeAgentId` so the selector + sidebar reflect the terminal surface.
 *
 * Lazily initialized from the persisted `preferredAgent` setting so the
 * selection survives restarts (terminal *sessions* themselves do not —
 * PTYs die with the server by design).
 */
const g = globalThis as unknown as {
  __libiTerminalSurface?: { active: boolean };
};

export function isTerminalSurfaceActive(): boolean {
  if (!g.__libiTerminalSurface) {
    let active = false;
    try {
      active = getSettings().preferredAgent === "terminal";
    } catch {
      // DB not migrated yet (early boot) — treat as inactive; the next
      // read after a real selectAgent() call sets the flag explicitly.
      return false;
    }
    g.__libiTerminalSurface = { active };
  }
  return g.__libiTerminalSurface.active;
}

export function setTerminalSurfaceActive(active: boolean): void {
  g.__libiTerminalSurface = { active };
}
