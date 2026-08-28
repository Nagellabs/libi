"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD = 100;
const SCROLL_COOLDOWN = 150;
const SAVE_DEBOUNCE = 300;

/** How much transcript there is, measured so that it can be compared against
 *  the same measure taken earlier. Computed by the caller (only it knows what
 *  a message is) and handed here purely so the size can be remembered NEXT to
 *  the scroll offset — a saved position is only meaningful against the
 *  transcript it was taken in. */
export type TranscriptSize = { count: number; tail: number; progress: number };

/** What one session's entry in localStorage holds. `size` is null for entries
 *  written before sizes were stored, and for callers that pass no size. */
type SavedPosition = { top: number; size: TranscriptSize | null };

function isSize(value: unknown): value is TranscriptSize {
  if (typeof value !== "object" || value === null) return false;
  const { count, tail, progress } = value as Record<string, unknown>;
  return (
    Number.isFinite(count) && Number.isFinite(tail) && Number.isFinite(progress)
  );
}

/** Reads either shape this key has ever held. Releases before this one wrote a
 *  BARE NUMBER, and every existing user has one under every session they have
 *  visited — so a bare number must keep restoring exactly as it did. It simply
 *  carries no size, which reads as "nothing known to have arrived" and lands
 *  the user back where they were: the pre-upgrade behaviour, once, until the
 *  first save under the new shape replaces it. */
function readSaved(raw: string | null): SavedPosition | null {
  if (raw === null) return null;
  if (!raw.startsWith("{")) {
    const top = Number(raw);
    return Number.isFinite(top) ? { top, size: null } : null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { top, size } = parsed as Record<string, unknown>;
    if (!Number.isFinite(top)) return null;
    return { top: Number(top), size: isSize(size) ? size : null };
  } catch {
    // A hand-edited or truncated value is not worth crashing a chat over.
    return null;
  }
}

function writeSaved(key: string, top: number, size: TranscriptSize | null): void {
  // Still a bare number when there is no size to carry, so a caller that
  // passes none writes precisely what earlier releases wrote.
  localStorage.setItem(key, size ? JSON.stringify({ top, size }) : String(top));
}

/** Did the transcript move on since the position was saved?
 *
 *  Deliberately looser than the chat panel's own unread test, which requires
 *  the message COUNT to match before it trusts tail growth: there, a shrinking
 *  list means the transcript was reset and must not read as arriving content.
 *  Here the comparison is made the moment a session's messages arrive, and the
 *  first batch of a live session can be a PARTIAL tail (SSE beats the history
 *  fetch) — fewer messages than were stored, yet unmistakably newer content.
 *  So a smaller count is not evidence either way, and the tail and the
 *  tool-progress checksum are read on their own merits. */
function hasGrownSince(saved: TranscriptSize, current: TranscriptSize): boolean {
  return (
    current.count > saved.count ||
    current.tail > saved.tail ||
    current.progress !== saved.progress
  );
}

/**
 * Manages auto-scroll for a chat container.
 *
 * The caller controls when scrolling happens by calling:
 * - scrollToBottom() — on user send, SSE content, etc.
 * - restoreSavedPosition() — after messages load
 *
 * Auto-scroll is disabled when user scrolls away from bottom
 * (detected via scroll events, works with all input methods).
 * Re-enabled when user scrolls back to bottom or calls scrollToBottom().
 *
 * Persists scroll position per sessionId to localStorage, together with how
 * much transcript there was when it was saved — see `restoreSavedPosition`.
 */
export function useScrollToBottom(
  sessionId?: string,
  /** The transcript's current size, if the caller can measure it. Supplying it
   *  is what lets a return to a session the agent worked in land on the newest
   *  message instead of the offset the user left behind. */
  transcriptSize?: TranscriptSize,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The `libi:chat-scroll:` prefix is load-bearing across releases: it is what
  // every user's already-saved offsets are filed under. The parameter used to
  // be called `pieceId` even though the one caller has always passed a session
  // id — renaming it is safe precisely because the key is built from the VALUE,
  // not the name. Changing the prefix would silently orphan every saved
  // position instead of failing anywhere visible.
  const storageKey = sessionId ? `libi:chat-scroll:${sessionId}` : null;

  // `restoreSavedPosition` reads the key through this ref rather than closing
  // over it, so its IDENTITY never changes when the session does. That matters
  // because the chat panel keys its one-shot restore effect on the callback:
  // `useAgentChat` clears its messages in an effect, so a switch A→B produces
  // one commit where the session prop is B but A's transcript is still in the
  // DOM. A callback whose identity moved there re-ran that effect against A's
  // DOM — scrolling A to B's offset and spending the one shot, so B's real
  // messages never got restored at all.
  const storageKeyRef = useRef(storageKey);
  useEffect(() => {
    storageKeyRef.current = storageKey;
  }, [storageKey]);

  // Same reasoning for the size: read through a ref so `restoreSavedPosition`
  // stays identity-stable. This effect is declared inside the hook, hence
  // before the panel's restore effect, so the size is already the incoming
  // session's by the time the restore runs on that commit.
  const sizeRef = useRef(transcriptSize);
  useEffect(() => {
    sizeRef.current = transcriptSize;
  }, [transcriptSize]);

  // The key whose saved position has been applied, or null. Nothing may be
  // persisted until the CURRENT key is that key: emptying the container across
  // a switch makes the browser clamp scrollTop toward 0, and a debounced write
  // would save that clamp as the incoming session's remembered position.
  // Holding the key rather than a bare boolean makes the gate independent of
  // the order effects happen to run in on the commit where the key changes —
  // on that commit it simply does not match yet. It is cleared as well, in the
  // listener effect, because a SECOND visit to a session restored earlier must
  // re-close the gate for its own empty interim.
  const restoredKeyRef = useRef<string | null>(null);

  const checkIfAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    setIsAtBottom(true);
  }, []);

  /**
   * Position the container for a session the user has just opened.
   *
   * Where they were, UNLESS the agent wrote while they were elsewhere — then
   * the newest message, which is the thing they came back to see (this is what
   * Claude Code and Codex do). The question is asked of the TRANSCRIPT, not of
   * whether a turn happened to finish, so a session still mid-answer — the
   * common shape of "the agent has been working" — counts too.
   */
  const restoreSavedPosition = useCallback(() => {
    const key = storageKeyRef.current;
    if (!key) return;
    const el = containerRef.current;
    if (!el) return;

    // Whichever branch runs below, this session's position is now settled:
    // everything after this is the user's own scrolling and safe to persist.
    restoredKeyRef.current = key;

    const size = sizeRef.current ?? null;
    const saved = readSaved(localStorage.getItem(key));

    // Two ways to land on the newest message. Nothing remembered: a chat opens
    // at its latest, because leaving scrollTop where the outgoing session left
    // it would strand the user part-way up a transcript they have never seen,
    // and leave `isAtBottom` holding the previous session's answer (a pill
    // with nothing behind it). Or the transcript grew while they were away,
    // which is the thing they switched back to read.
    const grew = saved?.size != null && size != null && hasGrownSince(saved.size, size);
    if (!saved || grew) {
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      setIsAtBottom(true);
      // Record what they are now looking at, so the very next visit compares
      // against this transcript rather than announcing the same growth twice.
      writeSaved(key, el.scrollTop, size);
      return;
    }

    el.scrollTo({ top: saved.top, behavior: "instant" });
    setIsAtBottom(
      el.scrollHeight - saved.top - el.clientHeight < BOTTOM_THRESHOLD,
    );
    writeSaved(key, saved.top, size);
  }, []);

  // Keep the remembered size level with what the user is CURRENTLY watching.
  // Growth they sat through — the pill's whole scenario, a user reading back
  // while the answer continues below them — is not growth they were away for,
  // and must not yank them off the position they deliberately held when they
  // flick to another session and back.
  useEffect(() => {
    if (!storageKey || restoredKeyRef.current !== storageKey) return;
    const el = containerRef.current;
    if (!el) return;
    // Shares the one save timer with the scroll handler: both write the same
    // single record, so the later of the two simply wins, and the listener
    // effect's teardown still cancels whatever is pending when the key moves.
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      writeSaved(storageKey, el.scrollTop, sizeRef.current ?? null);
    }, SAVE_DEBOUNCE);
  }, [storageKey, transcriptSize]);

  // Track scroll position + persist to localStorage
  useEffect(() => {
    // A new key means a new session, whose saved position has not been applied
    // yet — close the persist gate. Pairing the reset with the listener that
    // reads it is what makes the ordering safe: a scroll event that beats this
    // effect is still handled by the PREVIOUS listener, which closes over the
    // previous key and so cannot write under the new one either way.
    restoredKeyRef.current = null;

    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      isUserScrollingRef.current = true;
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, SCROLL_COOLDOWN);

      setIsAtBottom(checkIfAtBottom());

      // Debounce localStorage writes (scroll fires at ~60fps). `storageKey`
      // stays a dependency of this effect on purpose: the teardown below
      // cancels any pending write when the session changes, which is what
      // stops the outgoing session's offset landing under the incoming
      // session's key during a rapid back-and-forth.
      if (storageKey && restoredKeyRef.current === storageKey) {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => {
          writeSaved(storageKey, el.scrollTop, sizeRef.current ?? null);
        }, SAVE_DEBOUNCE);
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [checkIfAtBottom, storageKey]);

  return { containerRef, isAtBottom, scrollToBottom, restoreSavedPosition };
}
