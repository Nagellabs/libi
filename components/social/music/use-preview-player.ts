"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Playback isn't implemented everywhere (jsdom): the state is still right. */
function safe(fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
  } catch {
    // no media playback in this environment
  }
}

/**
 * Every mounted player's `stop` — ONE preview at a time across the whole app
 * (the Music step's pickers, the details panel's rows and its picker dialog
 * each own a player): whichever starts playing stops every other.
 */
const players = new Set<() => void>();

/** ONE <audio> element for a whole picker: one preview plays at a time, and it stops on unmount. */
export function usePreviewPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** The loaded `<audio>` src, kept independent of any list the id came from —
   *  a caller can resume/pause the CURRENT playback without re-finding the
   *  track it belongs to (a search result list can change under it). */
  const [currentSrc, setCurrentSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.8);

  const toggle = useCallback(
    (id: string, src: string) => {
      const el = audioRef.current;
      if (!el) return;
      if (currentId === id) {
        safe(() => (playing ? el.pause() : el.play()));
        return;
      }
      safe(() => el.pause());
      el.src = src;
      el.volume = volume;
      setCurrentId(id);
      setCurrentSrc(src);
      setTime(0);
      setDuration(0);
      safe(() => el.play());
    },
    [currentId, playing, volume],
  );
  const seek = useCallback((s: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = s;
    setTime(s);
  }, []);
  const setVolume = useCallback((v: number) => {
    const c = Math.min(1, Math.max(0, v));
    setVolumeState(c);
    if (audioRef.current) audioRef.current.volume = c;
  }, []);
  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) safe(() => el.pause());
    setPlaying(false);
  }, []);
  useEffect(() => {
    const el = audioRef.current;
    players.add(stop);
    return () => {
      players.delete(stop);
      if (el) safe(() => el.pause());
    };
  }, [stop]);

  return {
    audioRef,
    currentId,
    currentSrc,
    playing,
    time,
    duration,
    volume,
    toggle,
    seek,
    setVolume,
    stop,
    audioProps: {
      onPlay: () => {
        for (const other of players) if (other !== stop) other();
        setPlaying(true);
      },
      onPause: () => setPlaying(false),
      onEnded: () => setPlaying(false),
      onTimeUpdate: () => setTime(audioRef.current?.currentTime ?? 0),
      onLoadedMetadata: () => setDuration(Number.isFinite(audioRef.current?.duration) ? audioRef.current!.duration : 0),
    },
  };
}
