"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExportProgressBar } from "@/components/export/export-progress-bar";
import {
  type ExportSource,
  type ExportQuality,
  type ExportFormat,
  type UseExportFlowResult,
} from "@/hooks/editor/use-export-flow";
import type { GraphicsQuality } from "@/lib/engine/types";
import { useExportDefaults } from "@/lib/queries/export-defaults";
import {
  presetDimensions,
  isUpscaling as computeIsUpscaling,
  resolveOutputDimensions,
  DEFAULT_GRAPHICS_QUALITY,
  GRAPHICS_SHARPNESS_WARNING,
  graphicsLosesSharpness,
} from "@/lib/export/quality";
import { revealFile, pickDirectory, hasElectronBridge } from "@/lib/shell/client";

/** The dialog offers no Custom UI (removed — API-only now), so its media
 *  quality state never takes the "custom" value. Narrowing the local state
 *  to this type lets `presetDimensions`/`resolveOutputDimensions` calls
 *  below skip re-litigating the custom-dims case. */
type DialogQuality = Exclude<ExportQuality, "custom">;

interface ExportDialogProps {
  pieceId: string | null;
  pieceName: string | null;
  /** Source composition dimensions, used for the "Match source" preset hint and
   *  the upscaling warning. */
  compositionWidth: number;
  compositionHeight: number;
  /** Whether the composition has any graphics overlays (text/code/3D, or a
   *  tracked overlay whose content is one of those). Gates whether the
   *  "Text, code & 3D" resolution row renders at all — a piece with no
   *  graphics has nothing for that tier to affect. */
  hasGraphics?: boolean;
  flow: UseExportFlowResult;
  hasSnapshot: boolean;
  hasDraft: boolean;
  /** Render the dialog with no Trigger when caller controls the open state. */
  openOverride?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Modal export dialog. Hosts:
 *   - Filename + source + format + quality form (idle state)
 *   - Live progress + ETA + cancel (running state)
 *   - Success card with show-in-folder (success state)
 *   - Error card with retry/dismiss (failed/cancelled state)
 *
 * Closing the dialog mid-export does NOT cancel — the flow stays alive and
 * the dialog will re-open into the live progress view next time. Cancel
 * only happens via the explicit Cancel button.
 */
export function ExportDialog(props: ExportDialogProps) {
  const {
    pieceId,
    pieceName,
    compositionWidth,
    compositionHeight,
    hasGraphics = false,
    flow,
    hasSnapshot,
    hasDraft,
    openOverride,
    onOpenChange,
  } = props;

  const [innerOpen, setInnerOpen] = useState(false);
  const open = openOverride ?? innerOpen;

  const isTerminalFlow =
    flow.status === "success" || flow.status === "failed" || flow.status === "cancelled";

  // When the dialog closes (any path: backdrop click, Esc, X button, our
  // explicit Done button) AND we're in a terminal state, reset the hook so
  // the next open shows the form fresh instead of the stale success card.
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next && isTerminalFlow) {
        flow.reset();
      }
      // Update internal state only when UNcontrolled; always fire onOpenChange
      // as a notification so a parent can observe open/close even without
      // taking over the open state (the post-close success toast relies on
      // knowing whether the dialog was closed when the export finished).
      if (openOverride === undefined) setInnerOpen(next);
      onOpenChange?.(next);
    },
    [isTerminalFlow, flow, openOverride, onOpenChange],
  );

  const { data: defaults } = useExportDefaults();

  // Lazy initializers seed from whatever is already known at mount; the
  // previous-state blocks below fold in later arrivals during render (React's
  // documented pattern) instead of via setState-in-effect cascades.
  const [source, setSource] = useState<ExportSource>(() =>
    !hasDraft && hasSnapshot ? "snapshot" : "draft",
  );
  const [format, setFormat] = useState<ExportFormat>(defaults?.format ?? "mp4");
  const [quality, setQuality] = useState<DialogQuality>(defaults?.quality ?? "source");
  const [graphicsQuality, setGraphicsQuality] = useState<GraphicsQuality>(
    defaults?.graphicsQuality ?? DEFAULT_GRAPHICS_QUALITY,
  );
  const [filename, setFilename] = useState<string>(pieceName ?? "libi-export");
  const [folderOverride, setFolderOverride] = useState<string | null>(null);

  const [prevPieceName, setPrevPieceName] = useState(pieceName);
  if (pieceName !== prevPieceName) {
    setPrevPieceName(pieceName);
    if (pieceName) setFilename(pieceName);
  }

  const [prevDefaults, setPrevDefaults] = useState(defaults);
  if (defaults !== prevDefaults) {
    setPrevDefaults(defaults);
    if (defaults) {
      setFormat(defaults.format);
      setQuality(defaults.quality);
      setGraphicsQuality(defaults.graphicsQuality);
    }
  }

  const [prevDraftAvail, setPrevDraftAvail] = useState({ hasDraft, hasSnapshot });
  if (hasDraft !== prevDraftAvail.hasDraft || hasSnapshot !== prevDraftAvail.hasSnapshot) {
    setPrevDraftAvail({ hasDraft, hasSnapshot });
    if (!hasDraft && hasSnapshot) setSource("snapshot");
  }

  // The media choice's OWN frame, ignoring graphics entirely — this is what
  // the media upscaling warning judges (upscaling the base video/images past
  // the composition), never the graphics tier pushing the output larger.
  // Derived from the SAME short-edge logic the server uses, rather than a
  // second hardcoded table — a stale copy here is what showed "1920×1080"
  // (and a false upscaling warning) for a portrait export.
  const mediaDims = useMemo(() => {
    if (quality === "source") return { width: compositionWidth, height: compositionHeight };
    return presetDimensions(quality, compositionWidth, compositionHeight);
  }, [quality, compositionWidth, compositionHeight]);

  const mediaIsUpscaling = computeIsUpscaling(mediaDims, compositionWidth, compositionHeight);

  // The actual output frame — the larger of the media and (when the piece
  // has graphics) graphics tiers, per resolveOutputDimensions. Drives the
  // "Output W×H" hint on the media field.
  const outputDims = useMemo(
    () =>
      resolveOutputDimensions({
        quality,
        graphicsQuality,
        hasGraphics,
        sourceWidth: compositionWidth,
        sourceHeight: compositionHeight,
      }),
    [quality, graphicsQuality, hasGraphics, compositionWidth, compositionHeight],
  );

  // Only warn when the text really comes out below 4K: media at 4K already
  // raises the frame there, whatever the graphics choice says.
  const fullGraphics = presetDimensions(DEFAULT_GRAPHICS_QUALITY, compositionWidth, compositionHeight);
  const graphicsWarning =
    graphicsLosesSharpness(graphicsQuality) &&
    outputDims.width * outputDims.height < fullGraphics.width * fullGraphics.height;

  const isRunning = flow.status === "starting" || flow.status === "running";

  // null until the first real tick → the running button shows its indeterminate
  // shimmer instead of a frozen 0% fill.
  const exportPercent =
    flow.progress && flow.progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((flow.progress.done / flow.progress.total) * 100)))
      : null;

  const folder = folderOverride ?? defaults?.effectiveFolder ?? "";

  const handleStart = useCallback(async () => {
    if (!pieceId) return;
    const stem = filename.trim() || pieceName?.trim() || "libi-export";
    await flow.start({
      pieceId,
      source,
      filename: stem,
      format,
      quality,
      // Sent even when hasGraphics is false — the server ignores it for a
      // graphics-free piece, and keeping it always-present means it never
      // silently drops out of the payload if graphics get added later.
      graphicsQuality,
      destFolder: folderOverride ?? undefined,
    });
  }, [pieceId, filename, pieceName, flow, source, format, quality, graphicsQuality, folderOverride]);

  const handlePickFolder = useCallback(async () => {
    const picked = await pickDirectory(folder);
    if (picked === undefined) {
      // No bridge — surface a hint in the input.
      return;
    }
    if (picked === null) return;
    setFolderOverride(picked);
  }, [folder]);

  const resultFilePath = flow.result?.filePath ?? null;
  const handleReveal = useCallback(async () => {
    if (resultFilePath) {
      await revealFile(resultFilePath);
    }
  }, [resultFilePath]);

  const handleClose = useCallback(() => {
    // setOpen handles the terminal-reset for us.
    setOpen(false);
  }, [setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {openOverride === undefined && (
        <DialogTrigger
          render={
            <button
              disabled={!pieceId}
              data-testid="export-button"
              className={
                "export-trigger group relative inline-flex cursor-pointer items-center overflow-hidden rounded-md px-3.5 py-1.5 text-xs font-semibold ring-1 ring-black/10 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none " +
                (isRunning
                  ? "bg-primary/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                  : "export-trigger-idle text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.22)] hover:-translate-y-px hover:shadow-[0_4px_12px_-2px_color-mix(in_oklab,var(--primary)_70%,transparent),inset_0_1px_0_rgba(255,255,255,0.28)] active:translate-y-0 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]")
              }
            >
              {/* Running: determinate fill grows to the real %, or an
                  indeterminate shimmer band before the first tick. */}
              {isRunning &&
                (exportPercent != null ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/85 to-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${exportPercent}%` }}
                  />
                ) : (
                  <span aria-hidden className="absolute inset-0 overflow-hidden">
                    <span className="export-trigger-shimmer absolute inset-y-0 w-2/5 bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
                  </span>
                ))}

              {/* Idle: one-shot light sheen sweep on hover. */}
              {!isRunning && (
                <span
                  aria-hidden
                  className="export-trigger-sheen pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-transparent via-white/35 to-transparent"
                />
              )}

              <span
                className={
                  "relative z-10 inline-flex items-center gap-1.5 " +
                  (isRunning ? "[text-shadow:0_1px_2px_rgba(0,0,0,0.65)]" : "")
                }
              >
                {isRunning ? (
                  <>
                    <ExportSpinner />
                    Exporting {exportPercent != null ? `${exportPercent}%` : "…"}
                  </>
                ) : (
                  <>
                    <ExportIcon className="transition-transform duration-150 group-hover:translate-y-0.5" />
                    Export
                  </>
                )}
              </span>
            </button>
          }
        />
      )}

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>
            {isRunning
              ? "Rendering — feel free to close this dialog and keep working."
              : flow.status === "success"
                ? "Done."
                : flow.status === "failed"
                  ? "Export failed."
                  : flow.status === "cancelled"
                    ? "Export cancelled."
                    : "Choose format, quality, and where to save."}
          </DialogDescription>
        </DialogHeader>

        {flow.status === "idle" || flow.status === "cancelled" ? (
          <div className="flex flex-col gap-4">
            <Field label="Filename">
              <div className="flex items-center gap-2">
                <Input
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="My Video"
                  className="flex-1"
                />
                <span className="text-xs text-muted-foreground">.{format}</span>
              </div>
            </Field>

            <Field label="Source">
              <Segmented
                value={source}
                onChange={(v) => setSource(v as ExportSource)}
                options={[
                  { value: "draft", label: "Draft", disabled: !hasDraft },
                  { value: "snapshot", label: "Snapshot", disabled: !hasSnapshot },
                ]}
              />
            </Field>

            <Field label="Format">
              <Segmented
                value={format}
                onChange={(v) => setFormat(v as ExportFormat)}
                options={[
                  { value: "mp4", label: "MP4" },
                  { value: "webm", label: "WebM" },
                ]}
              />
            </Field>

            <Field label="Videos & images" hint={`Output ${outputDims.width}×${outputDims.height}`}>
              <Segmented
                value={quality}
                onChange={(v) => setQuality(v as DialogQuality)}
                options={[
                  { value: "source", label: "Original" },
                  { value: "1080p", label: "1080p" },
                  { value: "1440p", label: "1440p" },
                  { value: "4k", label: "4K" },
                ]}
              />
              {mediaIsUpscaling && (
                <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  {`Videos and images are upscaled from ${compositionWidth}×${compositionHeight}: no added detail, larger file.`}
                </p>
              )}
            </Field>

            {hasGraphics && (
              <Field label="Text, code & 3D">
                <Segmented
                  value={graphicsQuality}
                  onChange={(v) => setGraphicsQuality(v as GraphicsQuality)}
                  options={[
                    { value: "1080p", label: "1080p" },
                    { value: "1440p", label: "1440p" },
                    { value: "4k", label: "4K" },
                  ]}
                />
                {graphicsWarning && (
                  <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                    {GRAPHICS_SHARPNESS_WARNING}
                  </p>
                )}
              </Field>
            )}

            <Field label="Save to">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 overflow-hidden truncate rounded-md border border-input bg-background px-2 py-1.5 text-xs text-muted-foreground">
                  {folder || "(default folder)"}
                </div>
                {hasElectronBridge() ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePickFolder}
                    className="cursor-pointer"
                    type="button"
                  >
                    Change…
                  </Button>
                ) : null}
                {folderOverride && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFolderOverride(null)}
                    className="cursor-pointer"
                    type="button"
                  >
                    Reset
                  </Button>
                )}
              </div>
            </Field>

            {flow.status === "cancelled" && (
              <div className="rounded bg-muted/30 p-2 text-xs text-muted-foreground">
                Last export was cancelled. Adjust the settings and try again.
              </div>
            )}
          </div>
        ) : null}

        {isRunning ? (
          <ProgressView
            progress={flow.progress}
            onCancel={flow.cancel}
          />
        ) : null}

        {flow.status === "success" && flow.result ? (
          <SuccessView result={flow.result} onReveal={handleReveal} />
        ) : null}

        {flow.status === "failed" ? (
          <div className="rounded bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
            {flow.error ?? "Export failed."}
          </div>
        ) : null}

        <DialogFooter>
          {flow.status === "idle" || flow.status === "cancelled" ? (
            <>
              <Button variant="ghost" onClick={handleClose} className="cursor-pointer">
                Cancel
              </Button>
              <Button
                onClick={handleStart}
                disabled={!pieceId || !filename.trim()}
                className="cursor-pointer"
              >
                Export
              </Button>
            </>
          ) : flow.status === "success" || flow.status === "failed" ? (
            <Button onClick={handleClose} className="cursor-pointer">
              Done
            </Button>
          ) : (
            <Button variant="outline" onClick={handleClose} className="cursor-pointer">
              Hide (export keeps running)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
}
function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SegmentedOption[];
}) {
  return (
    <div className="flex w-full overflow-hidden rounded-md border border-input bg-background">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            onClick={() => !o.disabled && onChange(o.value)}
            className={
              "flex-1 cursor-pointer px-2 py-1.5 text-xs font-medium transition-colors " +
              (selected
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-foreground">{label}</label>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ProgressView({
  progress,
  onCancel,
}: {
  progress: { done: number; total: number; unit: string; etaMs: number | null } | null;
  onCancel: () => Promise<void>;
}) {
  // null until the first real tick → the bar renders its indeterminate
  // shimmer (so "Preparing…/encoding" never looks frozen). Once progress
  // arrives we drive the determinate filmstrip fill off the actual %.
  const percent =
    progress && progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)))
      : null;
  const eta = progress?.etaMs != null ? `~${formatEta(progress.etaMs)} left` : null;

  return (
    <div className="flex flex-col gap-3">
      <ExportProgressBar percent={percent} etaLabel={eta} />
      <Button
        variant="outline"
        size="sm"
        onClick={() => void onCancel()}
        className="cursor-pointer self-start"
      >
        Cancel export
      </Button>
    </div>
  );
}

function SuccessView({
  result,
  onReveal,
}: {
  result: {
    filePath: string;
    sizeBytes: number;
    durationSeconds: number;
    backend: string;
    width: number;
    height: number;
  };
  onReveal: () => Promise<void>;
}) {
  const filename = result.filePath.split(/[\\/]/).pop() ?? result.filePath;
  return (
    // min-w-0: as a grid item of DialogContent's `grid`, this card's min-content
    // would otherwise be driven by the no-wrap full file path below, forcing the
    // grid track (and the whole dialog) wider than max-w-md and spilling the
    // footer past the rounded corner. min-w-0 caps the track so the path truncates.
    <div className="flex min-w-0 flex-col gap-2 rounded bg-emerald-500/10 p-3 text-xs">
      <div className="break-words font-medium text-emerald-700 dark:text-emerald-400">
        Saved {filename}
      </div>
      <div className="text-muted-foreground">
        {formatBytes(result.sizeBytes)} · {result.width}×{result.height} · {result.backend}
      </div>
      <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
        {result.filePath}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void onReveal()}
        className="cursor-pointer self-start"
      >
        Show in folder
      </Button>
    </div>
  );
}

function ExportIcon({ className }: { className?: string }) {
  // Download glyph: arrow pointing down to a baseline. Stroke-based (refined
  // over the old solid-fill version) for a lighter look at small size.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {/* arrow shaft + head, pointing down */}
      <path d="M8 2.6V9.7" />
      <path d="M5.2 6.9 8 9.7l2.8-2.8" />
      {/* baseline the arrow lands on */}
      <path d="M3.6 12.8h8.8" />
    </svg>
  );
}

function ExportSpinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
      <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatEta(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}
