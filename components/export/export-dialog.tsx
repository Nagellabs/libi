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
import { useExportDefaults } from "@/lib/queries/export-defaults";
import { revealFile, pickDirectory, hasElectronBridge } from "@/lib/shell/client";

interface ExportDialogProps {
  pieceId: string | null;
  pieceName: string | null;
  /** Source composition dimensions, used for the "Match source" preset hint and
   *  the upscaling warning. */
  compositionWidth: number;
  compositionHeight: number;
  /** Whether the composition has any overlays (text/image/video/code/three).
   *  Overlays are rendered procedurally at the export resolution, so upscaling
   *  DOES sharpen them (unlike the base video) — this flips the upscaling copy
   *  from "no benefit" to "overlays render sharper". */
  hasOverlays?: boolean;
  flow: UseExportFlowResult;
  hasSnapshot: boolean;
  hasDraft: boolean;
  /** Render the dialog with no Trigger when caller controls the open state. */
  openOverride?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const PRESET_DIMS: Record<Exclude<ExportQuality, "source" | "custom">, [number, number]> = {
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
};

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
    hasOverlays = false,
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
  const [quality, setQuality] = useState<ExportQuality>(defaults?.quality ?? "source");
  const [customW, setCustomW] = useState(1920);
  const [customH, setCustomH] = useState(1080);
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
    }
  }

  const [prevDraftAvail, setPrevDraftAvail] = useState({ hasDraft, hasSnapshot });
  if (hasDraft !== prevDraftAvail.hasDraft || hasSnapshot !== prevDraftAvail.hasSnapshot) {
    setPrevDraftAvail({ hasDraft, hasSnapshot });
    if (!hasDraft && hasSnapshot) setSource("snapshot");
  }

  const targetDims = useMemo(() => {
    if (quality === "source") return { width: compositionWidth, height: compositionHeight };
    if (quality === "custom") return { width: customW, height: customH };
    const [w, h] = PRESET_DIMS[quality];
    return { width: w, height: h };
  }, [quality, compositionWidth, compositionHeight, customW, customH]);

  const isUpscaling =
    targetDims.width > compositionWidth || targetDims.height > compositionHeight;

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
      customWidth: quality === "custom" ? customW : undefined,
      customHeight: quality === "custom" ? customH : undefined,
      destFolder: folderOverride ?? undefined,
    });
  }, [
    pieceId,
    filename,
    pieceName,
    flow,
    source,
    format,
    quality,
    customW,
    customH,
    folderOverride,
  ]);

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

            <Field
              label="Quality"
              hint={
                quality === "source"
                  ? `${compositionWidth}×${compositionHeight} (source)`
                  : `${targetDims.width}×${targetDims.height}`
              }
            >
              <Segmented
                value={quality}
                onChange={(v) => setQuality(v as ExportQuality)}
                options={[
                  { value: "source", label: "Source" },
                  { value: "1080p", label: "1080p" },
                  { value: "1440p", label: "1440p" },
                  { value: "4k", label: "4K" },
                  { value: "custom", label: "Custom" },
                ]}
              />
              {quality === "custom" && (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    type="number"
                    value={customW}
                    onChange={(e) => setCustomW(parseInt(e.target.value, 10) || 0)}
                    className="w-24"
                    aria-label="Width"
                  />
                  <span className="text-xs text-muted-foreground">×</span>
                  <Input
                    type="number"
                    value={customH}
                    onChange={(e) => setCustomH(parseInt(e.target.value, 10) || 0)}
                    className="w-24"
                    aria-label="Height"
                  />
                  <span className="text-xs text-muted-foreground">px</span>
                </div>
              )}
              {isUpscaling && (
                <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  {hasOverlays
                    ? `The ${compositionWidth}×${compositionHeight} video will be upscaled — it won't gain detail — but text, graphics & 3D overlays are re-rendered sharp at this resolution. Larger file.`
                    : `Upscaling from ${compositionWidth}×${compositionHeight} — the file will be larger without added detail.`}
                </p>
              )}
              {quality === "source" && hasOverlays && compositionHeight < 1080 && (
                <p className="mt-2 rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                  {`Overlays render at the source resolution (${compositionWidth}×${compositionHeight}). For crisper text & graphics, pick 1080p or higher — the video is upscaled, but overlays stay sharp.`}
                </p>
              )}
            </Field>

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
