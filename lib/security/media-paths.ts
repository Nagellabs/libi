/**
 * The routes that serve STORED BYTES from libi's own origin — bytes a template
 * author, a remote server or an upload chose. Navigated to directly, one of them
 * must never become a page that runs as libi, so proxy.ts gives these paths
 * `MEDIA_RESPONSE_CSP` (`default-src 'none'; sandbox`) instead of the page CSP.
 *
 * Why the PROXY and not the route: Next copies the proxy's response headers
 * onto the response before the handler runs and keeps them over the handler's
 * own, so a route's CSP never reaches the browser (final review I1; the same
 * behaviour feat/templates-sandbox measured live on 3461).
 *
 * A subresource's CSP is ignored when it is EMBEDDED (`<img>`, `<video>`,
 * `@font-face`, a fetch), so this costs the editor nothing; e2e/media-headers
 * asserts both halves through a real server.
 */
const MEDIA_SERVING_PATHS: readonly RegExp[] = [
  /^\/api\/templates\/[^/]+\/media\/[^/]+$/,
  /^\/api\/files\/by-id\/[^/]+\/content$/,
  // A public template's link-only audio/video, fetched from a stranger's host (lib/templates/cloud/asset-stream.ts).
  /^\/api\/templates\/cloud\/asset-stream$/,
  // A piece file by its stored name. Also matches the JSON `by-id/<id>` route,
  // where the policy is harmless (a fetch() ignores it).
  /^\/api\/files\/[^/]+\/[^/]+$/,
];

export function isMediaServingPath(pathname: string): boolean {
  return MEDIA_SERVING_PATHS.some((re) => re.test(pathname));
}
