/**
 * What one export costs the machine, before it starts — the scheduler's
 * admission input (lib/export/admission.ts). Pure.
 *
 * The numbers come from a measurement, not a guess (2026-10-01, M-series Mac):
 * videotoolbox serializes encode sessions, but a second session overlaps
 * filter-graph work (+36% throughput with a real overlay graph) and there were
 * 0 failures at 4 concurrent sessions. The Chromium figures are defaults: a
 * headless floor was measured at ~160 MB per window / ~110 MB per page, the real
 * /render page was not.
 */
export type CostBackend = "stream-copy-trim" | "ffmpeg-overlay" | "chromium-render";

export const MB = 1024 * 1024;
export const PIXELS_1080P = 1920 * 1080;

export const COST_TABLE = {
  /** `-c copy`: a demux/mux, no decode. */
  streamCopy: { memoryMB: 64, cpu: 0.25 },
  /** One ffmpeg decoding the inputs and encoding the frame. */
  ffmpegOverlay: { baseMB: 300, perMegapixelMB: 450, hwCpu: 1 },
  /** A hidden window + one render page per chunk worker; the final mux is `-c:v copy`. */
  chromium: { windowMB: 600, pageMBAt1080p: 350 },
} as const;

/**
 * Simultaneous h264_videotoolbox sessions we admit on this Mac. The strict
 * "adds throughput" rule measured 1; 2 is the ruling, because the second
 * session overlaps filter-graph work and nothing failed up to 4.
 */
export const HW_SESSION_CAP_DARWIN = 2;
/** Not measured (no Windows/Linux GPU in the lab): consumer NVENC allows a few sessions. */
export const HW_SESSION_CAP_OTHER = 2;
/** May an export whose hardware session is taken run as libx264 instead of waiting? Measured safe. */
export const SOFTWARE_FALLBACK_SAFE = true;

export interface CostInput {
  backend: CostBackend;
  width: number;
  height: number;
  format: "mp4" | "webm";
  cores: number;
  /** A hardware H.264 encoder exists on this machine (pickEncoder ≠ libx264). */
  hwEncoderAvailable: boolean;
  /** chromium-render only: the chunk pages it plans to open. */
  renderWorkers: number;
}

export interface CostEstimate {
  backend: CostBackend;
  memoryBytes: number;
  /** Cores it keeps busy. */
  cpu: number;
  /** Needs a hardware encoder session. */
  hwEncoder: boolean;
  /** Could run as libx264 instead (an ffmpeg-overlay MP4 with a hardware encoder). */
  softwareFallback: boolean;
  renderWorkers: number;
}

export function estimateCost(input: CostInput): CostEstimate {
  const megapixels = (input.width * input.height) / 1e6;
  const resolutionFactor = Math.max(1, (input.width * input.height) / PIXELS_1080P);
  if (input.backend === "stream-copy-trim") {
    return {
      backend: input.backend,
      memoryBytes: COST_TABLE.streamCopy.memoryMB * MB,
      cpu: COST_TABLE.streamCopy.cpu,
      hwEncoder: false,
      softwareFallback: false,
      renderWorkers: 0,
    };
  }
  if (input.backend === "ffmpeg-overlay") {
    const hw = input.format === "mp4" && input.hwEncoderAvailable;
    return {
      backend: input.backend,
      memoryBytes: Math.round((COST_TABLE.ffmpegOverlay.baseMB + COST_TABLE.ffmpegOverlay.perMegapixelMB * megapixels) * MB),
      cpu: hw ? COST_TABLE.ffmpegOverlay.hwCpu : input.cores / 2,
      hwEncoder: hw,
      softwareFallback: hw,
      renderWorkers: 0,
    };
  }
  const workers = Math.max(1, input.renderWorkers);
  return {
    backend: input.backend,
    memoryBytes: Math.round((COST_TABLE.chromium.windowMB + workers * COST_TABLE.chromium.pageMBAt1080p * resolutionFactor) * MB),
    cpu: workers,
    hwEncoder: false,
    softwareFallback: false,
    renderWorkers: workers,
  };
}

/** The same export as libx264 — what it costs when the hardware session is taken. */
export function softwareVariant(estimate: CostEstimate, cores: number): CostEstimate {
  return { ...estimate, hwEncoder: false, softwareFallback: false, cpu: cores / 2 };
}
