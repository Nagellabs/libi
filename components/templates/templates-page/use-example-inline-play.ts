"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { claimInline, releaseInline } from "@/components/templates/templates-page/use-example-hover-play";
import { trackEvent } from "@/lib/analytics/client";
import { playQuietly } from "@/lib/media/play-quietly";

/**
 * One card at a time plays its example WITH sound and controls; starting
 * another stops it. Hover previews elsewhere stay muted and never stop it
 * (they use the hover slot, not this one). Escape inside the player, its Stop
 * control, or the clip's end stops it — the card then shows its poster again.
 *
 * Focus follows the player (D2–D4 review I3): starting moves it to the video,
 * so a keyboard user is not left on `<body>` when the play button unmounts;
 * stopping from inside the player (Escape, Stop, the clip's end while it has
 * focus) returns it to the play button. A card stopped because ANOTHER card
 * started leaves the focus where the user put it.
 *
 * Escape is heard on the player only (`onPlayerKeyDown`), not on the window:
 * an Escape that closes a Select or a menu elsewhere on the page must not
 * also stop the clip (review M8).
 *
 * `src` null = the card has no example; `start` then does nothing.
 */
export function useExampleInlinePlay(src: string | null): {
  playing: boolean;
  start: () => void;
  stop: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playButtonRef: React.RefObject<HTMLButtonElement | null>;
  playerRef: React.RefObject<HTMLDivElement | null>;
  onPlayerKeyDown: (e: KeyboardEvent) => void;
} {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playButtonRef = useRef<HTMLButtonElement | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // Set when a stop came from inside this player: the play button gets the focus back once it is rendered again.
  const returnFocus = useRef(false);
  // This card's stop, held in the shared slot by identity (see the hover hook).
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => {
    stopRef.current = () => {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      returnFocus.current = !!active && !!playerRef.current?.contains(active);
      setPlaying(false);
      releaseInline(stopRef);
    };
  }, []);

  const start = () => {
    if (!src) return;
    claimInline(stopRef);
    setPlaying(true);
    trackEvent("template_example_played", { where: "card" });
  };
  const stop = () => stopRef.current();
  const onPlayerKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    stopRef.current();
  };

  useEffect(() => {
    if (playing) {
      // `autoPlay` alone is not enough in every engine once the element mounts
      // after the click; asking explicitly keeps it inside the user's gesture.
      void playQuietly(videoRef.current);
      videoRef.current?.focus();
      return;
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      playButtonRef.current?.focus();
    }
  }, [playing]);

  // A card removed mid-play (a delete, a filter, a view switch) must not keep the slot.
  useEffect(
    () => () => {
      releaseInline(stopRef);
    },
    [],
  );

  return { playing, start, stop, videoRef, playButtonRef, playerRef, onPlayerKeyDown };
}
