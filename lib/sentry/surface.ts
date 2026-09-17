// Which of libi's two distributions a Sentry event came from.
//
// WHY THIS EXISTS. The same runtime ships two ways — inside the Electron
// desktop shell, and as `npx @nagellabs/libi` in the user's own browser — and
// a large class of bugs only happens in one of them. Screen capture, native
// file dialogs, window chrome, the preload bridge, update installation: all
// behave differently, and more than one of those has already been mistaken for
// a general failure when it was specific to a shell. Without this tag a report
// gives no way to tell, so triage starts by guessing.
//
// Sentry's own `contexts` cannot answer it: the Electron renderer reports as
// Chrome on macOS, which is exactly what an `npx` user in Chrome reports too.

/** The distribution an event came from. */
export type LibiSurface = "electron" | "web";

/**
 * Detect the surface, on either side of the wire.
 *
 * BROWSER: the `electronAPI` global that `electron/preload.ts` exposes through
 * `contextBridge`. Preload runs before any page script, so it is already there
 * when `Sentry.init` evaluates this — and it is the same signal
 * `components/layout/top-bar.tsx#detectPlatform` already trusts to decide
 * whether to draw window chrome.
 *
 * SERVER: `LIBI_SHELL_API_MIN`, which `electron/main.ts` sets on `process.env`
 * before it hands off to the runtime (main.ts:506). It is absent under `npx`,
 * where nothing sets it. Chosen over `LIBI_RUNTIME_SOURCE`, which describes
 * WHICH runtime was selected — bundled, staged, npm — not what is hosting it,
 * and which is set on some non-Electron paths too.
 *
 * Defaults to `"web"` on an unrecognised host rather than guessing: an
 * `npx`-shaped report that is really Electron costs a triager one wrong
 * assumption, while a crash in the detector itself would cost the whole event.
 */
export function detectSurface(): LibiSurface {
  if (typeof window !== "undefined") {
    return (window as { electronAPI?: unknown }).electronAPI ? "electron" : "web";
  }
  return process.env.LIBI_SHELL_API_MIN ? "electron" : "web";
}

/**
 * The Sentry tag key. A single exported constant so the init files, the tests,
 * and anyone searching Sentry for it all agree on the spelling — a tag typo is
 * invisible until someone tries to filter by it and finds nothing.
 */
export const SURFACE_TAG = "libi.surface";
