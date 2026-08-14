"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD = 100;
const SCROLL_COOLDOWN = 150;

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
 * Persists scroll position per pieceId to localStorage.
 */
export function useScrollToBottom(pieceId?: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageKey = pieceId ? `libi:chat-scroll:${pieceId}` : null;

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

  const restoreSavedPosition = useCallback(() => {
    if (!storageKey) return;
    const el = containerRef.current;
    if (!el) return;

    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const pos = Number(saved);
      el.scrollTo({ top: pos, behavior: "instant" });
      setIsAtBottom(
        el.scrollHeight - pos - el.clientHeight < BOTTOM_THRESHOLD,
      );
    }
  }, [storageKey]);

  // Track scroll position + persist to localStorage
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      isUserScrollingRef.current = true;
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, SCROLL_COOLDOWN);

      setIsAtBottom(checkIfAtBottom());

      // Debounce localStorage writes (scroll fires at ~60fps)
      if (storageKey) {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => {
          localStorage.setItem(storageKey, String(el.scrollTop));
        }, 300);
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
