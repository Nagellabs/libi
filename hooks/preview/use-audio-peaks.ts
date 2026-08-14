"use client";

import { useEffect, useState } from "react";
import { computePeaks } from "@/lib/audio/peaks";

export interface AudioPeaks {
  /** Normalized 0..1 peak per bucket over the WHOLE source. */
  peaks: number[];
  /** Decoded source duration in seconds (for windowing by trim). */
  duration: number;
}

/** How many peak buckets to compute across the whole source. ~600 is plenty for
 *  a timeline bar at any zoom; the component samples down from these. */
const BUCKETS = 600;

// Module-level cache keyed by fileId so SSE refetches / row re-mounts don't
// re-decode. "error" memoizes a failed/unsupported decode (e.g. a video
// container Web Audio can't decode) so we don't retry every render.
const cache = new Map<string, AudioPeaks | "error">();

let sharedCtx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/**
 * Decode an audio (or audio-bearing) file and compute its waveform peaks,
 * client-side and cached. Returns null while loading or when the file can't be
 * decoded (the caller falls back to the solid bar). Best-effort for inline
 * video audio — some video containers don't decode via Web Audio, which is fine.
 */
export function useAudioPeaks(fileId: string | undefined): AudioPeaks | null {
  const [, force] = useState(0);

  useEffect(() => {
    if (!fileId || cache.has(fileId)) return;
    let cancelled = false;
    const ctx = audioCtx();
    if (!ctx) {
      cache.set(fileId, "error");
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/files/by-id/${fileId}/content`);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        const ch = decoded.getChannelData(0);
        cache.set(fileId, { peaks: computePeaks(ch, BUCKETS), duration: decoded.duration });
      } catch {
        cache.set(fileId, "error");
      }
      if (!cancelled) force((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (!fileId) return null;
  const entry = cache.get(fileId);
  return entry && entry !== "error" ? entry : null;
}
