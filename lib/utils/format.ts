export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getAssetUrl(pieceId: string, filename: string): string {
  return `/api/files/${pieceId}/${filename}`;
}

/**
 * Compact relative time ("just now", "5m ago", "3d ago", else a date).
 * Returns "—" for absent or unparseable input, so callers can render it
 * directly without a null branch.
 */
export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.floor((Date.now() - then) / 1000);
  // 60, not 45: below a full minute `Math.floor(s / 60)` is 0, and the next
  // branch would render the nonsense "0m ago" for the whole 45–59s window.
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Format seconds as `m:ss` (or `mm:ss` when minutes ≥ 10). Used by Script
 *  tab components for shot start/end + sound-design timestamps. */
export function formatTimecode(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** First non-empty line of a string, truncated to 200 chars. Returns undefined for null/empty input.
 *  Used to surface the most-recent agent breadcrumb in tooltips. */
export const firstNonEmptyLine = (s: string | null | undefined): string | undefined => {
  if (!s) return undefined;
  const line = s.split("\n").find((l) => l.trim().length > 0);
  return line ? line.slice(0, 200) : undefined;
};
