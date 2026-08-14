/**
 * Which whole-page screen the editor owes the user before it has a piece open.
 *
 * Pulled out of app/(app)/editor/page.tsx as a pure function because the
 * condition it replaces was wrong in a way that reads as correct:
 *
 *     if (!piecesQuery.isLoading && (piecesQuery.data ?? []).length === 0)
 *
 * `data ?? []` turns "the request FAILED" into "you have no pieces". A user
 * with a dozen pieces and a 500 from GET /api/pieces was shown
 * "Welcome to libi — create your first piece", which is not a degraded answer
 * but a false one; and the button under it POSTed to the same broken endpoint,
 * so it appeared to do nothing at all. Observed in dev Electron against a
 * server whose DB was a migration behind.
 *
 * The distinction that matters: `undefined` data means we have never
 * successfully loaded, an empty array means we loaded and there genuinely is
 * nothing. React Query keeps the last good `data` through a failed refetch, so
 * a blip while data is already on screen must NOT throw the user to an error
 * page — hence `isError && data === undefined` rather than `isError` alone.
 */

export type PiecesScreen =
  /** Loading and failure are indistinguishable to the user only in that both
   *  mean "we cannot answer yet" — but only one of them is worth an error UI. */
  | "unavailable"
  /** Loaded successfully; the library really is empty. */
  | "welcome"
  /** Nothing special — render the editor (which has its own empty state for
   *  "pieces exist, none open"). */
  | null;

export interface PiecesScreenState {
  /** True once a piece is open — every screen below is moot. */
  hasActivePiece: boolean;
  isError: boolean;
  /** `undefined` until the first successful load. */
  data: readonly unknown[] | undefined;
}

export function resolvePiecesScreen({
  hasActivePiece,
  isError,
  data,
}: PiecesScreenState): PiecesScreen {
  if (hasActivePiece) return null;
  if (isError && data === undefined) return "unavailable";
  if (data && data.length === 0) return "welcome";
  return null;
}
