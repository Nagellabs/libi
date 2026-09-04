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

/** The platform whose file manager a reveal will actually open. */
export type ShellPlatform = "darwin" | "win32" | "linux";

/**
 * Platform of the machine whose file manager will open.
 *
 * Prefers the Electron preload bridge, which reports `process.platform`
 * from the main process. Under `npx` there is no bridge, so this falls
 * back to sniffing the user agent — the browser and the server are the
 * same machine in that mode. The sniff is COSMETIC ONLY: it decides the
 * wording of a menu item, never behaviour. A wrong label still performs
 * the correct reveal, because the action itself is carried out by
 * Electron or resolved server-side.
 */
export function getShellPlatform(): ShellPlatform {
  const fromBridge = bridge()?.platform;
  if (fromBridge === "darwin" || fromBridge === "win32") return fromBridge;
  if (fromBridge) return "linux";

  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac/i.test(ua)) return "darwin";
  return "linux";
}

/** Native wording for the reveal action on a given platform. */
export function revealLabel(platform: ShellPlatform): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Show in File Explorer";
  return "Open containing folder";
}

/**
 * Resolve an asset's absolute path by id, then reveal it. Silently does
 * nothing if the file row is gone (404) or the path can't be resolved —
 * reveal is fire-and-forget by design, and the caller is a context-menu
 * click with nowhere to put an error.
 */
export async function revealFileById(fileId: string): Promise<void> {
  let path: string | undefined;
  try {
    const res = await fetch(`/api/files/by-id/${fileId}/location`);
    if (!res.ok) return;
    const data = (await res.json()) as { path?: string };
    path = data?.path;
  } catch {
    return;
  }
  if (!path) return;
  try {
    // Reveal is fire-and-forget by design and the caller is a menu click
    // with nowhere to surface an error, so swallow a rejecting bridge call
    // or a rejecting /api/shell/reveal fetch rather than let it escape as
    // an unhandled rejection.
    await revealFile(path);
  } catch {
    // Swallowed intentionally — see comment above.
  }
}
