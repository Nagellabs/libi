"use client";

import type { Composition } from "@/lib/engine/types";
import type { BaseSceneDetails } from "@/lib/preview/scene-details";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function fmtDims(w: number | null, h: number | null): string {
  if (w != null && h != null) return `${w}×${h}`;
  if (h != null) return `${h}p`;
  return "—";
}

/** Read-only details for a selected (or playhead) scene. */
export function SceneDetailsBody({
  details,
  composition,
}: {
  details: BaseSceneDetails;
  composition: Composition | null;
}) {
  if (!details.scene) {
    return <div className="text-[11px] text-muted-foreground">No scene at the playhead.</div>;
  }
  const { scene, video } = details;
  return (
    <div className="space-y-2">
      <div>
        <div data-testid="inspector-scene-name" className="truncate text-[12px] font-semibold text-foreground" title={scene.name}>
          {scene.name}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {scene.type === "video" ? "Video scene" : "Canvas scene"} · {fmtTime(scene.startSec)}–{fmtTime(scene.endSec)}
        </div>
      </div>
      {scene.type === "canvas" && composition && (
        <div className="text-[11px] text-muted-foreground">
          Rendered at composition resolution {composition.width}×{composition.height}.
        </div>
      )}
      {video && (
        <div className="rounded-md border border-border bg-background/60 p-2.5">
          <div className="truncate text-[11.5px] font-semibold text-foreground" title={video.fileName}>
            {video.fileName}
          </div>
          <dl className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
            <div className="flex items-baseline justify-between gap-2">
              <dt>Source</dt>
              <dd className="text-foreground/90">{fmtDims(video.sourceWidth, video.sourceHeight)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt>Preview</dt>
              <dd className="text-foreground/90">
                {video.effectivePreviewHeight != null ? `${video.effectivePreviewHeight}p` : "—"}
              </dd>
            </div>
          </dl>
          {video.matchesSource != null && (
            <div className="mt-1.5 text-[10.5px] text-muted-foreground/80">
              {video.matchesSource ? "Preview = source" : "Export uses the original"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
