// components/editor/analysis-frame-drawer.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { AnalysisKeyframe } from "@/lib/analysis/types";
import type { FrameDescription } from "@/lib/analysis/types";

interface Props {
  keyframe: AnalysisKeyframe;
  description: FrameDescription | null;
  fileId: string;
  onClose: () => void;
}

function formatTimecode(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Compute percentage-based rect from source-pixel bbox and natural image dims */
function bboxToPercent(
  bbox: readonly [number, number, number, number],
  naturalW: number,
  naturalH: number,
) {
  const [x1, y1, x2, y2] = bbox;
  return {
    left: `${((x1 / naturalW) * 100).toFixed(2)}%`,
    top: `${((y1 / naturalH) * 100).toFixed(2)}%`,
    width: `${(((x2 - x1) / naturalW) * 100).toFixed(2)}%`,
    height: `${(((y2 - y1) / naturalH) * 100).toFixed(2)}%`,
  };
}

export function AnalysisFrameDrawer({ keyframe, description, fileId, onClose }: Props) {
  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Track natural image dimensions for bbox overlays
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  function handleImageLoad() {
    const img = imgRef.current;
    if (img) setImageDims({ w: img.naturalWidth, h: img.naturalHeight });
  }

  const thumbnailUrl = keyframe.filePath
    ? `/api/files/by-id/${fileId}/analysis/frames/${keyframe.filePath}`
    : null;

  const hasCustom =
    description?.custom && Object.keys(description.custom).length > 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        className="fixed inset-y-0 right-0 z-50 flex w-[min(480px,90vw)] flex-col overflow-hidden border-l bg-popover shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Frame detail"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
          <span className="font-mono text-xs text-muted-foreground">
            {keyframe.timestamp != null && (
              <>{formatTimecode(keyframe.timestamp)} · </>
            )}
            frame {keyframe.frameIndex ?? "?"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Thumbnail with bbox overlays */}
          {thumbnailUrl && (
            <div className="relative w-full">
              <img
                ref={imgRef}
                src={thumbnailUrl}
                alt={description?.scene ?? "keyframe"}
                onLoad={handleImageLoad}
                className="block h-auto w-full"
              />
              {/* Bbox overlays — only rendered once we know natural dims */}
              {imageDims && description && (
                <>
                  {description.people.map((person, i) =>
                    person.bbox ? (
                      <div
                        key={`person-${i}`}
                        className="pointer-events-none absolute rounded border-2 border-blue-400"
                        style={bboxToPercent(person.bbox, imageDims.w, imageDims.h)}
                        title={person.id ?? `person ${i + 1}`}
                      />
                    ) : null,
                  )}
                  {description.objects.map((obj, i) =>
                    obj.bbox ? (
                      <div
                        key={`obj-${i}`}
                        className="pointer-events-none absolute rounded border-2 border-amber-400"
                        style={bboxToPercent(obj.bbox, imageDims.w, imageDims.h)}
                        title={obj.name}
                      />
                    ) : null,
                  )}
                </>
              )}
            </div>
          )}
          {!thumbnailUrl && (
            <div className="aspect-video w-full bg-muted" />
          )}

          {/* Description body */}
          <div className="space-y-4 p-4 text-sm">
            {description === null ? (
              <p className="text-muted-foreground">
                {keyframe.skipped
                  ? `Frame skipped${keyframe.skipReason ? `: ${keyframe.skipReason}` : ""}`
                  : "No description yet"}
              </p>
            ) : (
              <>
                {/* Scene */}
                <p className="leading-relaxed">{description.scene}</p>

                {/* Setting */}
                {(description.setting.location ||
                  description.setting.time_of_day ||
                  description.setting.lighting) && (
                  <section>
                    <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Setting
                    </h5>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {description.setting.location && (
                        <span className="rounded bg-muted/50 px-2 py-0.5">
                          📍 {description.setting.location}
                        </span>
                      )}
                      {description.setting.time_of_day && (
                        <span className="rounded bg-muted/50 px-2 py-0.5">
                          {description.setting.time_of_day}
                        </span>
                      )}
                      {description.setting.lighting && (
                        <span className="rounded bg-muted/50 px-2 py-0.5">
                          {description.setting.lighting}
                        </span>
                      )}
                    </div>
                  </section>
                )}

                {/* People */}
                {description.people.length > 0 && (
                  <section>
                    <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      People
                    </h5>
                    <ul className="space-y-2">
                      {description.people.map((person, i) => (
                        <li
                          key={i}
                          className="rounded border bg-muted/30 p-2.5 space-y-1"
                        >
                          <div className="flex items-center gap-2">
                            {person.id && (
                              <span className="inline-flex h-5 items-center rounded-full bg-blue-500/20 px-2 text-xs font-medium text-blue-400">
                                {person.id}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {person.description}
                          </p>
                          <div className="flex flex-wrap gap-1.5 text-xs">
                            {person.pose && (
                              <span className="rounded bg-muted px-1.5 py-0.5">
                                {person.pose}
                              </span>
                            )}
                            {person.facing && (
                              <span className="rounded bg-muted px-1.5 py-0.5">
                                facing {person.facing}
                              </span>
                            )}
                            {person.visible_parts?.map((part) => (
                              <span
                                key={part}
                                className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                              >
                                {part}
                              </span>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* Objects */}
                {description.objects.length > 0 && (
                  <section>
                    <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Objects
                    </h5>
                    <ul className="space-y-1.5">
                      {description.objects.map((obj, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 rounded border bg-muted/30 p-2"
                        >
                          <span className="inline-flex h-5 items-center rounded-full bg-amber-500/20 px-2 text-xs font-medium text-amber-400">
                            {obj.name}
                          </span>
                          {obj.description && (
                            <span className="text-xs text-muted-foreground">
                              {obj.description}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* Camera */}
                {description.camera &&
                  (description.camera.shot ||
                    description.camera.angle ||
                    description.camera.motion) && (
                    <section>
                      <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Camera
                      </h5>
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        {description.camera.shot && (
                          <span className="rounded bg-muted px-2 py-0.5">
                            shot: {description.camera.shot}
                          </span>
                        )}
                        {description.camera.angle && (
                          <span className="rounded bg-muted px-2 py-0.5">
                            angle: {description.camera.angle}
                          </span>
                        )}
                        {description.camera.motion && (
                          <span className="rounded bg-muted px-2 py-0.5">
                            motion: {description.camera.motion}
                          </span>
                        )}
                      </div>
                    </section>
                  )}

                {/* Actions */}
                {description.actions && description.actions.length > 0 && (
                  <section>
                    <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Actions
                    </h5>
                    <div className="flex flex-wrap gap-1.5">
                      {description.actions.map((action, i) => (
                        <span
                          key={i}
                          className="rounded-full border border-border bg-muted/30 px-2.5 py-0.5 text-xs"
                        >
                          {action}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                {/* Tags */}
                {description.tags && description.tags.length > 0 && (
                  <section>
                    <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Tags
                    </h5>
                    <div className="flex flex-wrap gap-1.5">
                      {description.tags.map((tag, i) => (
                        <span
                          key={i}
                          className="rounded-full border border-border bg-muted/30 px-2.5 py-0.5 text-xs text-muted-foreground"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                {/* Text on screen */}
                {description.text_on_screen &&
                  description.text_on_screen.length > 0 && (
                    <section>
                      <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Text on Screen
                      </h5>
                      <ul className="space-y-1">
                        {description.text_on_screen.map((txt, i) => (
                          <li
                            key={i}
                            className="border-l-2 border-muted-foreground/30 pl-3 text-xs italic text-muted-foreground"
                          >
                            &ldquo;{txt}&rdquo;
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                {/* Custom block */}
                {hasCustom && (
                  <section>
                    <details className="rounded border bg-muted/30">
                      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-muted-foreground">
                        Custom data ({Object.keys(description.custom!).join(", ")})
                      </summary>
                      <pre className="overflow-auto px-3 pb-3 text-xs text-muted-foreground">
                        {JSON.stringify(description.custom, null, 2)}
                      </pre>
                    </details>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
