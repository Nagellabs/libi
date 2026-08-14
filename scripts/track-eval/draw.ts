import type { SKRSContext2D } from "@napi-rs/canvas";
import type { TrackSample } from "@/lib/tracking/types";

export interface DrawOpts {
  segmentLabel: string;
  segmentStatus: string;
  /** Distinct stroke color per segment for at-a-glance composition. */
  color?: string;
}

export function drawTrackBox(
  ctx: SKRSContext2D,
  sample: TrackSample,
  opts: DrawOpts,
): void {
  const caption = `t=${sample.t.toFixed(2)}s conf=${sample.confidence.toFixed(2)} ` +
    `vis=${sample.visible} [${opts.segmentLabel}/${opts.segmentStatus}]`;

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, ctx.measureText(caption).width + 12, 24);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(caption, 6, 17);

  if (!sample.visible) return;

  ctx.strokeStyle = opts.color ?? "#ff2d2d";
  ctx.lineWidth = 3;
  ctx.strokeRect(sample.x, sample.y, sample.w, sample.h);
}
