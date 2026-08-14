"use client";

/** Type-safe wrapper around the Electron preload bridge with a graceful
 *  fallback to the HTTP /api/shell/reveal route for the web/BYO-CLI case. */

interface ElectronApi {
  platform?: string;
  revealFile?: (absPath: string) => Promise<void>;
  pickDirectory?: (initialPath?: string) => Promise<string | null>;
}

function bridge(): ElectronApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { electronAPI?: ElectronApi }).electronAPI;
}

/** Reveal a file in the OS file manager. Falls back to the HTTP route
 *  when not running in Electron. */
export async function revealFile(absPath: string): Promise<void> {
  const api = bridge();
  if (api?.revealFile) {
    await api.revealFile(absPath);
    return;
  }
  await fetch("/api/shell/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: absPath }),
  });
}

/** Open a native directory picker. Returns `null` if the user cancelled,
 *  or `undefined` when the bridge isn't available (UI should show a text
 *  input instead). */
export async function pickDirectory(initialPath?: string): Promise<string | null | undefined> {
  const api = bridge();
  if (api?.pickDirectory) {
    return await api.pickDirectory(initialPath);
  }
  return undefined;
}

/** True iff the Electron preload bridge is available (matters for the
 *  Settings UI deciding between native picker vs text input). */
export function hasElectronBridge(): boolean {
  return bridge()?.revealFile !== undefined;
}
