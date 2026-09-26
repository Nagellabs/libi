/**
 * The one allowlist of media types libi will STORE for bytes someone else chose
 * (a template's assets, a template's hosted downloads) and SERVE inline from its
 * own origin (`/api/files/by-id/:id/content`, `/api/files/:pieceId/:filename`,
 * `/api/templates/:id/media/:name`).
 *
 * Why it exists: a content type is the browser's instruction for what to do with
 * a navigated response. `text/html` (or an SVG with `<script>`) served from
 * libi's origin runs as libi, and libi's page CSP allows inline script — so a
 * type chosen by a stranger's `template.json`, or by the server a template URL
 * points at, must never reach the `Content-Type` header. Types are therefore
 * DERIVED here — from the file's extension and the asset's declared kind — and
 * anything outside the table is either refused (at store time) or served as an
 * `attachment` of `application/octet-stream` (at serve time).
 *
 * Client-safe (no node imports): the scaffold schema, which the UI imports,
 * validates asset extensions against the same table.
 */

// The per-kind extension table and the two helpers the scaffold schema needs
// are DEFINED in lib/templates/scaffold-schema.ts: libi-site copies that file
// byte-for-byte and it may import nothing but zod, so the table lives there and
// is re-exported here. This module owns everything built on top of it.
import { MEDIA_TYPES_BY_KIND, extensionOf, mediaTypeFor, type MediaKind } from "@/lib/templates/scaffold-schema";

export { MEDIA_TYPES_BY_KIND, extensionOf, mediaTypeFor, type MediaKind };

/** Types an already-stored row may carry and still be served inline: every
 *  canonical type above plus the common spellings of the same formats that
 *  uploads and providers declare. The only document types are SVG (served with
 *  `MEDIA_RESPONSE_CSP`) and PDF, which the asset viewer shows in an `<embed>` —
 *  Chromium's viewer renders it with the sandbox CSP on (checked in Electron,
 *  2026-09-23), and a PDF's own script never runs in libi's origin. */
const INLINE_ALIASES = [
  "application/pdf",
  "image/jpg",
  "image/pjpeg",
  "audio/mp3",
  "audio/x-wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-flac",
  "audio/opus",
  "video/ogg",
  "video/x-m4v",
  "font/sfnt",
  "font/collection",
  "application/font-woff",
  "application/x-font-ttf",
  "application/font-sfnt",
  "application/vnd.ms-opentype",
] as const;

export const SVG_TYPE = "image/svg+xml";

/** The CSP an SVG (or any media response) gets: no script, no subresource, and
 *  an opaque origin. It governs the response only when it is NAVIGATED to as a
 *  document — `<img>`/`<video>`/`@font-face` embedding ignores a subresource's
 *  CSP, so it costs the editor nothing. */
export const MEDIA_RESPONSE_CSP = "default-src 'none'; sandbox";

const CANONICAL_TYPES = new Set(
  Object.values(MEDIA_TYPES_BY_KIND).flatMap((table) => Object.values(table)),
);
const INLINE_TYPES = new Set<string>([...CANONICAL_TYPES, ...INLINE_ALIASES]);

/** The essence of a Content-Type header value (`Image/PNG; x=1` → `image/png`),
 *  or "" for nothing. */
export function typeEssence(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** The extension a file of this kind and content type should carry, or null
 *  when the type is not an allowed one for the kind. */
export function extensionForType(kind: MediaKind, contentType: string | null | undefined): string | null {
  const essence = typeEssence(contentType);
  const hit = Object.entries(MEDIA_TYPES_BY_KIND[kind]).find(([, t]) => t === essence);
  return hit ? hit[0] : null;
}

/** The type for a filename regardless of kind (the first kind that allows the
 *  extension), or null. For a route that serves a name without a kind. */
export function anyMediaTypeFor(filename: string): string | null {
  const ext = extensionOf(filename);
  for (const kind of Object.keys(MEDIA_TYPES_BY_KIND) as MediaKind[]) {
    const t = MEDIA_TYPES_BY_KIND[kind][ext];
    if (t) return t;
  }
  return null;
}

/**
 * The content type to STORE for bytes whose type a stranger declared (a remote
 * server's `Content-Type`). The declared type is kept only when it is an allowed
 * media type; otherwise the filename's extension decides; otherwise null, and
 * the caller must refuse to store the file. A declared `text/html` on a `.png`
 * URL is stored as `image/png`, so the bytes can never be served as a page.
 */
export function safeStoredMediaType(declared: string | null | undefined, filename: string): string | null {
  const essence = typeEssence(declared);
  if (CANONICAL_TYPES.has(essence)) return essence;
  return anyMediaTypeFor(filename);
}

/** Whether a stored type may be served inline from libi's origin. */
export function isInlineMediaType(contentType: string | null | undefined): boolean {
  return INLINE_TYPES.has(typeEssence(contentType));
}

/** `attachment` with an ASCII-only filename: the name is user/agent text and
 *  must not be able to break out of the quoted header value. */
function attachmentDisposition(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "download";
  return `attachment; filename="${safe}"`;
}

/**
 * How a route serves STORED bytes from libi's origin — the one rule every
 * route that serves a piece's files applies (`/api/files/by-id/:id/content`,
 * `/api/files/:pieceId/:filename`).
 *
 * The stored type is not trusted to be safe to RENDER: a template asset, a
 * downloaded file or an upload can carry `text/html` (or an SVG with script),
 * and a navigation to the URL would then run it as libi. Only an allowlisted
 * media type is served inline; anything else goes out as an opaque
 * `application/octet-stream` attachment. The bytes are the same either way, so
 * `fetch()` callers (the text viewer, audio peaks) are unaffected. `nosniff`
 * always; an SVG also gets `MEDIA_RESPONSE_CSP` (proxy.ts sets the same policy
 * by path — this keeps a route safe on its own).
 */
export function storedBytesServing(
  storedType: string | null | undefined,
  filename: string,
): { contentType: string; headers: Record<string, string> } {
  const inline = isInlineMediaType(storedType);
  const essence = typeEssence(storedType);
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (!inline) headers["Content-Disposition"] = attachmentDisposition(filename);
  if (inline && essence === SVG_TYPE) headers["Content-Security-Policy"] = MEDIA_RESPONSE_CSP;
  return { contentType: inline ? essence : "application/octet-stream", headers };
}
