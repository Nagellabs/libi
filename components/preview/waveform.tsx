"use client";

import { useEffect, useRef } from "react";
import { peaksWindow } from "@/lib/audio/peaks";
import { useAudioPeaks } from "@/hooks/preview/use-audio-peaks";

interface WaveformProps {
  /** Source file id (audio, or audio-bearing video for inline clips). */
  fileId: string | undefined;
  /** Source-window start (seconds) — the clip's trimStart. */
  trimStart: number;
  /** Window length (seconds) — the clip's duration. */
  duration: number;
  /** Bar color (CSS color). */
  color: string;
  className?: string;
}

/**
 * A lightweight canvas waveform for an audio clip bar. Decodes peaks client-side
 * (cached) and paints the clip's source window. Renders nothing (transparent)
 * until peaks are ready or if the file can't be decoded — the bar's solid color
 * shows through, so this only ever ENHANCES the bar.
 */
export function Waveform({ fileId, trimStart, duration, color, className }: WaveformProps) {
  const data = useAudioPeaks(fileId);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!data) return;

    const win = peaksWindow(data.peaks, data.duration, trimStart, duration);
    if (!win.length) return;
    const mid = cssH / 2;
    // One vertical bar per ~2px column, sampling the windowed peaks.
    const cols = Math.max(1, Math.floor(cssW / 2));
    ctx.fillStyle = color;
    for (let c = 0; c < cols; c++) {
      const idx = Math.min(win.length - 1, Math.floor((c / cols) * win.length));
      const amp = win[idx];
      const h = Math.max(0.5, amp * (cssH - 2));
      const x = (c / cols) * cssW;
      ctx.fillRect(x, mid - h / 2, 1.2, h);
    }
  }, [data, trimStart, duration, color]);

  return <canvas ref={ref} className={className} style={{ width: "100%", height: "100%" }} />;
}
