/**
 * `LIBI_OVERLAY_SANDBOX=0` runs bodies IN the app origin: the same worker
 * script, spawned as a same-origin blob: worker on a MessageChannel instead of
 * inside the sandboxed iframe — the same protocol, engine and watchdog, minus
 * the isolation. It exists to tell "the runtime is broken" from "the boundary
 * is blocking something" while developing the runtime itself, and for nothing
 * else: it is refused in a packaged build (like LIBI_CDP) and in any production
 * server (`npx @nagellabs/libi`), and there is no user-facing toggle because a
 * toggle is a hole (spec §4.10).
 *
 * PREVIEW ONLY. The editor's preview reads the mode from the root layout's
 * meta; the export render page (lib/export/render-entry.ts) is not rendered
 * under that layout and always uses the sandbox — so an export made while
 * diagnosing still goes through the real boundary.
 */
export type OverlaySandboxMode = "sandbox" | "in-origin";

export const OVERLAY_SANDBOX_MODE_META = "libi-overlay-sandbox-mode";

/**
 * Server-side decision. `env` is a plain record rather than
 * `NodeJS.ProcessEnv`, whose Next typing makes `NODE_ENV` required
 * (see lib/runtime/registry-url.ts for the same choice).
 */
export function resolveOverlaySandboxMode(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): OverlaySandboxMode {
  if (isPackaged || env.NODE_ENV === "production") return "sandbox";
  return env.LIBI_OVERLAY_SANDBOX === "0" ? "in-origin" : "sandbox";
}

/** The client reads what the server decided from the layout's meta; anything
 *  missing or unexpected is the sandbox. A production client bundle refuses
 *  in-origin whatever the meta says — defence in depth behind the server gate:
 *  Next inlines `process.env.NODE_ENV` at build time, so no meta a production
 *  page ever carries can switch the boundary off. */
export function readOverlaySandboxMode(doc: Document): OverlaySandboxMode {
  if (process.env.NODE_ENV === "production") return "sandbox";
  const content = doc.querySelector(`meta[name="${OVERLAY_SANDBOX_MODE_META}"]`)?.getAttribute("content");
  return content === "in-origin" ? "in-origin" : "sandbox";
}
