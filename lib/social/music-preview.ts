/** Music previews play from libi's own origin (spec §6.5): only the
 *  platforms' own https CDNs, through the SSRF-guarded fetch the template
 *  asset stream uses. The app CSP is NOT widened for them. */
export const MUSIC_PREVIEW_HOST_SUFFIXES = ["tiktokcdn.com", "tiktokcdn-us.com", "cdninstagram.com", "fbcdn.net"] as const;

export function previewHostAllowed(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase().replace(/\.+$/, "");
    return MUSIC_PREVIEW_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

export function musicPreviewSrc(url: string): string {
  return `/api/social/music/preview?url=${encodeURIComponent(url)}`;
}

/** A catalog track's artwork, through the same proxy (the app CSP is not widened for platform CDNs). */
export function musicArtworkSrc(url: string): string {
  return `/api/social/music/preview?kind=artwork&url=${encodeURIComponent(url)}`;
}
