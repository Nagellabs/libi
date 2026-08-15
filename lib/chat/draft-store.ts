// ---------------------------------------------------------------------------
// Per-session composer drafts, persisted to `sessionStorage`.
//
// Two things used to vanish on a page reload:
//
//   1. Text typed into the composer but not yet sent.
//   2. The text of an optimistic message whose POST /api/agent/send failed —
//      the `sendFailed` bubble (and its Retry button) lives only in client
//      memory, so a reload silently destroyed the user's words.
//
// Both now survive: the composer mirrors its value here on every keystroke,
// and a failed send backs its text up here so the reloaded composer restores
// it. `sessionStorage` (not `localStorage`) on purpose — a reload keeps it,
// closing the tab garbage-collects it, and drafts never accumulate across
// browser sessions.
//
// Every function is a guarded no-op when storage is unavailable (SSR, private
// browsing, quota) — drafts are a courtesy, never a failure mode.
// ---------------------------------------------------------------------------

const PREFIX = "libi:chat-draft:";

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The persisted draft for a session, or "" when there is none. */
export function loadDraft(sessionId: string | null): string {
  if (!sessionId) return "";
  try {
    return storage()?.getItem(PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

/** Persist the composer's current value; an empty value removes the entry. */
export function saveDraft(sessionId: string | null, text: string): void {
  if (!sessionId) return;
  try {
    const s = storage();
    if (!s) return;
    if (text) s.setItem(PREFIX + sessionId, text);
    else s.removeItem(PREFIX + sessionId);
  } catch {
    // Quota exceeded / access denied — best-effort by design.
  }
}

/**
 * Back up the text of a send that failed, so a reload restores it into the
 * composer. Only fills an EMPTY slot: if the user has already typed a newer
 * draft since submitting, that newer draft wins.
 */
export function backupFailedSend(sessionId: string | null, text: string): void {
  if (!sessionId || !text) return;
  if (loadDraft(sessionId)) return;
  saveDraft(sessionId, text);
}

/**
 * A delivered send supersedes a backup of the same text (the retry path:
 * fail → backup → retry succeeds → the backup must not resurface on the next
 * reload). A non-matching draft is left alone — it is newer typing.
 */
export function clearBackupOnDelivery(
  sessionId: string | null,
  text: string,
): void {
  if (!sessionId) return;
  if (loadDraft(sessionId) === text) saveDraft(sessionId, "");
}
