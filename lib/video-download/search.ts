/** Longest search text handed to yt-dlp. */
export const SEARCH_MAX_CHARS = 200;

/** A search as yt-dlp gets it: one line, single spaces. Empty means there is nothing to search for. */
export function normaliseSearch(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, SEARCH_MAX_CHARS).trim();
}
