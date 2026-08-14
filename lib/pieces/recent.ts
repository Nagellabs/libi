/**
 * Ordering for the "No piece open" recents list.
 *
 * Pure and dependency-free so the ranking can be tested without a DB, a
 * browser, or a clock.
 *
 * The rule is "most recently opened first", with one deliberate concession:
 * a piece that has never been opened still appears, ranked below every piece
 * that has, ordered among its peers by `updatedAt`. Without that concession
 * the list would be EMPTY on exactly the install where it matters most — a
 * user whose pieces were all created by the agent, who has opened none of
 * them, and who is staring at the empty state wondering what to click.
 *
 * The concession is in the ordering only, never in the labelling: callers must
 * render "Opened <t>" only when `lastOpenedAt` is set and say something else
 * ("Updated <t>") otherwise. Coalescing the two into one timestamp would be
 * simpler and would quietly tell the user they opened something they never did.
 */

export interface RecentPieceCandidate {
  id: string;
  /** ISO string, or null/undefined when the piece has never been opened. */
  lastOpenedAt?: string | null;
  /** ISO string. Fallback ordering for never-opened pieces. */
  updatedAt?: string | null;
}

export const RECENT_PIECES_LIMIT = 5;

/** ms since epoch, or null for absent/unparseable input. */
function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The most recently opened pieces, newest first, capped at `limit`.
 * Never-opened pieces sort after every opened one (see the module comment).
 * Input is not mutated.
 */
export function recentPieces<T extends RecentPieceCandidate>(
  pieces: readonly T[],
  limit: number = RECENT_PIECES_LIMIT,
): T[] {
  if (limit <= 0) return [];

  return [...pieces]
    .sort((a, b) => {
      const openedA = timestamp(a.lastOpenedAt);
      const openedB = timestamp(b.lastOpenedAt);

      // Opened beats never-opened, regardless of how stale the open is: the
      // question the list answers is "where was I", not "what changed".
      if (openedA !== null && openedB === null) return -1;
      if (openedA === null && openedB !== null) return 1;
      if (openedA !== null && openedB !== null && openedA !== openedB) {
        return openedB - openedA;
      }

      const updatedA = timestamp(a.updatedAt) ?? 0;
      const updatedB = timestamp(b.updatedAt) ?? 0;
      return updatedB - updatedA;
    })
    .slice(0, limit);
}
