"use client";

import { useEffect, useRef, useState } from "react";
import { playQuietly } from "@/lib/media/play-quietly";

/**
 * At most one example plays at a time, across every card on the page (local
 * and public). A pointer crossing a row of cards fires the next card's enter
 * before the previous card's leave, so without this the grid ends up with
 * several clips running at once.
 *
 * What is held is the playing card's own `stop`, not its `<video>`: pausing
 * the element alone would leave that card still believing it is hovered, so
 * its poster would stay hidden behind a frozen frame.
 */
export type StopHandle = { current: () => void };
let playing: StopHandle | null = null;

/**
 * The second slot: the one card playing its example INLINE, with sound and
 * controls (`useExampleInlinePlay`). Separate from the hover slot on purpose —
 * a muted hover preview on another card never stops the one the user chose to
 * hear, and starting a new inline play stops the previous one.
 */
let inlinePlaying: StopHandle | null = null;

/** Take the inline slot, stopping whichever card held it. */
export function claimInline(handle: StopHandle): void {
  if (inlinePlaying && inlinePlaying !== handle) inlinePlaying.current();
  inlinePlaying = handle;
}

/** Give the slot up, if this card holds it. */
export function releaseInline(handle: StopHandle): void {
  if (inlinePlaying === handle) inlinePlaying = null;
}

function rewind(v: HTMLVideoElement | null): void {
  if (!v) return;
  v.pause();
  v.currentTime = 0;
}

/**
 * A card's example clip, played muted on hover/focus and stopped on leave.
 * `src` (null = the card has no example) is handed to the `<video>` only on
 * the first hover, so a grid of thirty cards does not open thirty streams on
 * load.
 *
 * The first hover therefore cannot play immediately — the element has no
 * source yet — and it cannot wait for `canplay` either: with `preload="none"`
 * nothing loads until something asks it to, so that event never arrives. The
 * effect below plays once React has committed the `src`, which is what starts
 * the download.
 */
export function useExampleHoverPlay(src: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);

  // This card's stop function, and — as a ref object with a stable identity —
  // the token `playing` holds. Written in an effect and read only from
  // handlers and effects, never during render.
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => {
    stopRef.current = () => {
      setHovering(false);
      rewind(videoRef.current);
      if (playing === stopRef) playing = null;
    };
  }, []);

  const play = () => {
    if (!src) return;
    if (playing && playing !== stopRef) playing.current();
    playing = stopRef;
    setHovering(true);
    if (!videoSrc) {
      setVideoSrc(src);
      return;
    }
    void playQuietly(videoRef.current);
  };
  const stop = () => stopRef.current();
  useEffect(() => {
    if (!videoSrc || !hovering) return;
    void playQuietly(videoRef.current);
  }, [videoSrc, hovering]);
  // A card removed mid-play (a delete, a filter) must not keep the slot. The
  // element is captured on mount: by the time a passive cleanup runs React has
  // already nulled the ref, so reading it there stopped nothing and left
  // `playing` pointing at a card that no longer exists.
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      rewind(v);
      if (playing === stopRef) playing = null;
    };
  }, []);

  return { videoRef, hovering, videoSrc, play, stop };
}
