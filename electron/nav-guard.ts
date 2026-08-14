/**
 * RC-G: pure origin-decision helpers for the main window's navigation guard.
 * Kept free of any `electron` import so the decision logic is unit-testable
 * without an Electron runtime. `electron/main.ts` wires these into
 * `webContents.on("will-navigate")` and `setWindowOpenHandler`.
 */

function isHttpUrl(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Decide what to do with an in-window navigation attempt.
 * - `allow` — the target is the app's own loopback origin; let it navigate.
 * - `openExternal` — a non-null URL means block the in-window nav but hand this
 *   http(s) URL to the OS browser (legitimate external link). Malformed or
 *   non-http(s) off-origin URLs return `{ allow: false, openExternal: null }`.
 */
export function navigationDecision(
  url: string,
  appOrigin: string,
): { allow: boolean; openExternal: string | null } {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.origin === appOrigin) {
    return { allow: true, openExternal: null };
  }
  return { allow: false, openExternal: parsed && isHttpUrl(parsed) ? url : null };
}

/**
 * A `window.open` / `target="_blank"` request is ALWAYS denied an Electron
 * window. Returns the URL to open in the OS browser when it's a legitimate
 * http(s) link, else null (deny outright).
 */
export function windowOpenExternal(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (isHttpUrl(parsed)) return url;
  } catch {
    /* malformed → deny */
  }
  return null;
}
