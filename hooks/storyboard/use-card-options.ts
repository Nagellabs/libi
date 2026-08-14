"use client";

import { useCallback, useState } from "react";

/** Per-piece, per-card visibility of a storyboard card's "general options"
 *  (generation params, prompt, detail labels, voiceover). Default HIDDEN — the
 *  card shows only its assets (sketches, images, audio, takes) until the user
 *  opts in. The choice is remembered per `(pieceId, cardId)` across board reopens
 *  via localStorage, so each card keeps its own state. */
const STORAGE_KEY = "libi:storyboard-card-options";

function readMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeKey(key: string, shown: boolean) {
  if (typeof window === "undefined") return;
  try {
    const map = readMap();
    if (shown) map[key] = true;
    else delete map[key];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / serialization failures — visibility is non-critical
  }
}

export function useCardOptionsShown(pieceId: string, cardId: string): [boolean, () => void] {
  const key = `${pieceId}::${cardId}`;
  const [shown, setShown] = useState<boolean>(() => readMap()[key] ?? false);
  const toggle = useCallback(() => {
    setShown((prev) => {
      const next = !prev;
      writeKey(key, next);
      return next;
    });
  }, [key]);
  return [shown, toggle];
}
