"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Music } from "lucide-react";
import type { FileRecord } from "@/lib/db/schema/types";
import { formatFileSize, formatTimecode } from "@/lib/utils/format";

/**
 * Audio asset preview: a player card with file metadata, a click-to-seek
 * waveform, and the native audio transport.
 *
 *  ┌──────────────────────────────────────────────┐
 *  │ [♪]  voiceover-take-3.mp3                    │
 *  │      MP3 · 1.2 MB · 0:42                     │
 *  │  ▂▅▇▆▃▁▂▆▇▅▂▁▃▅▆▇▅▃▂▁  ← waveform, seekable  │
 *  │  [▶ ──────●────────────  0:12 / 0:42  🔊]    │
 *  └──────────────────────────────────────────────┘
 *
 * The card has a real width (`w-full max-w-xl`) — the previous layout sized
 * the player against a shrink-to-fit flex wrapper, which collapsed the
 * native controls to their ~48px minimum.
 *
 * The `<audio>` element is registered on the shared `mediaRef`, so transcript
 * / summary click-to-seek drives audio assets exactly like video ones.
 */

/** Don't decode files larger than this for the waveform — decodeAudioData
 *  expands compressed audio to raw PCM in memory (~10 MB per stereo minute). */
const WAVEFORM_MAX_BYTES = 25 * 1024 * 1024;
/** Number of waveform buckets (bars) to render. */
const WAVEFORM_BUCKETS = 240;

interface Props {
  asset: FileRecord;
  mediaRef: RefObject<HTMLMediaElement | null>;
  onTimeUpdate: (t: number) => void;
}

export function AudioAssetView({ asset, mediaRef, onTimeUpdate }: Props) {
  const contentUrl = `/api/files/by-id/${asset.id}/content`;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [duration, setDuration] = useState<number | null>(
    asset.mediaDuration ?? null,
  );
  const [currentTime, setCurrentTime] = useState(0);
  const peaks = useWaveformPeaks(contentUrl, asset.size);

  // Reset playback-derived state when switching to a different asset —
  // adjusted during render (previous-state pattern), not in an effect.
  const [prevAssetId, setPrevAssetId] = useState(asset.id);
  if (asset.id !== prevAssetId) {
    setPrevAssetId(asset.id);
    setCurrentTime(0);
    setDuration(asset.mediaDuration ?? null);
  }

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onUpdate = () => {
      setCurrentTime(el.currentTime);
      onTimeUpdate(el.currentTime);
    };
    const onMeta = () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    };
    el.addEventListener("timeupdate", onUpdate);
    el.addEventListener("seeking", onUpdate);
    el.addEventListener("seeked", onUpdate);
    el.addEventListener("loadedmetadata", onMeta);
    return () => {
      el.removeEventListener("timeupdate", onUpdate);
      el.removeEventListener("seeking", onUpdate);
      el.removeEventListener("seeked", onUpdate);
      el.removeEventListener("loadedmetadata", onMeta);
    };
  }, [asset.id, onTimeUpdate]);

  const seekTo = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, t);
    if (el.paused) el.play().catch(() => {});
  }, []);

  const format = (asset.contentType ?? "")
    .replace(/^audio\//, "")
    .replace("mpeg", "mp3")
    .toUpperCase();
  const meta = [
    format || null,
    formatFileSize(asset.size),
    duration != null ? formatTimecode(duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="w-full max-w-xl rounded-xl border border-border bg-muted/40 p-4 shadow-sm">
      {/* Header: icon tile + name + meta */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Music className="size-5" strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">
            {asset.name || asset.filename}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {meta}
          </div>
        </div>
      </div>

      {/* Waveform (skipped for oversized / undecodable files) */}
      {peaks.state !== "failed" && (
        <Waveform
          peaks={peaks.state === "ready" ? peaks.peaks : null}
          progress={
            duration && duration > 0 ? Math.min(1, currentTime / duration) : 0
          }
          onSeekFraction={(f) => {
            if (duration && duration > 0) seekTo(f * duration);
          }}
        />
      )}

      {/* Native transport: play/pause, scrubber, time, volume — full width
          now that the card gives it a real width to fill. */}
      <audio
        ref={(el) => {
          audioRef.current = el;
          mediaRef.current = el;
        }}
        src={contentUrl}
        controls
        preload="metadata"
        className="mt-3 w-full"
      />
    </div>
  );
}

// ── Waveform ───────────────────────────────────────────────────────────

function Waveform({
  peaks,
  progress,
  onSeekFraction,
}: {
  peaks: Float32Array | null;
  progress: number;
  onSeekFraction: (fraction: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // The canvas carries `text-primary`, so computed `color` resolves the
    // theme token without depending on CSS variable naming.
    const color = getComputedStyle(canvas).color;
    const n = peaks.length;
    const barW = width / n;
    const gap = Math.min(1, barW * 0.3);
    const playedBars = Math.floor(progress * n);

    for (let i = 0; i < n; i++) {
      const h = Math.max(2, peaks[i] * (height - 4));
      const x = i * barW;
      const y = (height - h) / 2;
      ctx.globalAlpha = i < playedBars ? 1 : 0.3;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, Math.max(1, barW - gap), h);
    }
    ctx.globalAlpha = 1;
  }, [peaks, progress]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeekFraction(
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    );
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      role="slider"
      aria-label="Audio waveform — click to seek"
      className={
        "mt-3 h-16 w-full text-primary " +
        (peaks
          ? "cursor-pointer"
          : "animate-pulse rounded bg-muted-foreground/10")
      }
    />
  );
}

// ── Peak extraction ────────────────────────────────────────────────────

type PeaksState =
  | { state: "loading" }
  | { state: "ready"; peaks: Float32Array }
  | { state: "failed" };

/**
 * Fetch + decode the audio file and reduce it to normalized per-bucket peak
 * amplitudes. Oversized files (raw-PCM blowup) and decode failures resolve
 * to `failed` — the card simply renders without a waveform.
 */
function useWaveformPeaks(url: string, sizeBytes: number): PeaksState {
  // Oversized is a pure fact of the inputs — derive it instead of storing it,
  // so the effect never needs a synchronous setState.
  const oversized = sizeBytes > WAVEFORM_MAX_BYTES;
  const [state, setState] = useState<PeaksState>({ state: "loading" });

  // Back to "loading" on the render where the url changes (previous-state
  // pattern) — pre-paint, replacing the synchronous reset the effect did.
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) {
    setPrevUrl(url);
    setState({ state: "loading" });
  }

  useEffect(() => {
    if (oversized) return;
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = await res.arrayBuffer();
      // OfflineAudioContext decodes without claiming an audio output device.
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const decoded = await ctx.decodeAudioData(buf);
      if (cancelled) return;
      setState({ state: "ready", peaks: extractPeaks(decoded) });
    })().catch(() => {
      if (!cancelled) setState({ state: "failed" });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, oversized]);

  return oversized ? { state: "failed" } : state;
}

function extractPeaks(decoded: AudioBuffer): Float32Array {
  const data = decoded.getChannelData(0);
  const peaks = new Float32Array(WAVEFORM_BUCKETS);
  const samplesPerBucket = Math.max(1, Math.floor(data.length / WAVEFORM_BUCKETS));
  let max = 0;
  for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, data.length);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  // Normalize so quiet recordings still render a visible shape.
  if (max > 0) {
    for (let i = 0; i < WAVEFORM_BUCKETS; i++) peaks[i] /= max;
  }
  return peaks;
}
