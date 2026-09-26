/**
 * Where the overlay runtime lives. A leaf module on purpose: the iframe
 * transport runs in the export's render page, an esbuild IIFE with no
 * `process` global, and `lib/security/csp.ts` (which re-exports these) reads
 * `process.env` at module scope through its Sentry and social imports —
 * importing it there would throw before the page rendered a frame.
 */

/** The sandboxed overlay runtime page (spec §4.1 + A1: the supervisor). */
export const OVERLAY_RUNTIME_PATH = "/sandbox/overlay-runtime";
/** The one script the runtime page may load. Named by ABSOLUTE URL in its CSP
 *  because the page runs at an opaque origin, where `'self'` matches nothing. */
export const OVERLAY_RUNTIME_BUNDLE_PATH = "/api/sandbox/runtime-bundle";
