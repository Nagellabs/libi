"use client";

import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { Play, X } from "lucide-react";

/** Clicks on these, anywhere in a card, are their own action — never "open the template". */
const OWN_ACTION = "button, a, video, input, textarea, select, label, [role=menuitem], [role=menu], [role=dialog], [role=alertdialog]";

/**
 * A card's body click opens the template's page. A click that landed on a
 * control (Use, Delete, play, the report menu, the inline player's own
 * controls) is that control's, and a click inside a dialog the card opened is
 * ignored too: React bubbles a PORTALLED dialog's clicks to the card even
 * though the dialog is not inside it in the DOM.
 */
export function onCardBodyClick(e: MouseEvent<HTMLElement>, open: () => void): void {
  const target = e.target as Element | null;
  if (!target || !e.currentTarget.contains(target)) return;
  if (target.closest(OWN_ACTION)) return;
  open();
}

/**
 * A card's example player, beside — never inside — the preview image
 * (`role="img"` makes its children presentational, so a control inside it is
 * pruned from the accessibility tree; D2–D4 review I3). Idle, it is the round
 * play button centred on the media box: visible on hover or focus, always on
 * a touch screen (no hover there). Playing, it is the inline video — unmuted,
 * with the browser's controls — and a visible Stop in its corner, the mouse
 * user's way back to the poster. Focus moves with it: the refs and handlers
 * come from `useExampleInlinePlay`. `ids` names its parts per card kind.
 */
export function CardExamplePlayer({
  src,
  playing,
  onPlay,
  onStop,
  videoRef,
  playButtonRef,
  playerRef,
  onPlayerKeyDown,
  ids,
}: {
  src: string;
  playing: boolean;
  onPlay: () => void;
  onStop: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  playButtonRef: RefObject<HTMLButtonElement | null>;
  playerRef: RefObject<HTMLDivElement | null>;
  onPlayerKeyDown: (e: KeyboardEvent) => void;
  ids: { play: string; video: string; stop: string };
}) {
  if (!playing)
    return (
      <button
        ref={playButtonRef}
        type="button"
        aria-label="Play example with sound"
        data-testid={ids.play}
        onClick={onPlay}
        className="absolute top-1/2 left-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100 hover:bg-black/75 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Play className="size-5 translate-x-px fill-current" aria-hidden="true" />
      </button>
    );
  return (
    <div ref={playerRef} className="absolute inset-0" onKeyDown={onPlayerKeyDown}>
      <video
        ref={videoRef}
        data-testid={ids.video}
        src={src}
        aria-label="Example video"
        controls
        autoPlay
        playsInline
        disablePictureInPicture
        // A focus target when it starts, in every engine (with `controls` it is one anyway).
        tabIndex={0}
        onEnded={onStop}
        className="absolute inset-0 h-full w-full bg-black object-contain"
      />
      <button
        type="button"
        aria-label="Stop example"
        title="Stop example"
        data-testid={ids.stop}
        onClick={onStop}
        className="absolute top-1.5 right-1.5 flex size-7 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white shadow-md hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
