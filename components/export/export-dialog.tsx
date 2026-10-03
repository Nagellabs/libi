"use client";

import { useCallback, useMemo, useState } from "react";
import { openExportInTab } from "@/hooks/exports/use-open-export";
import { markExportForPost, openPostingTab } from "@/hooks/social/use-posting-intent";
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
import { Skeleton } from "@/components/ui/skeleton";
import { BusyLabel, BUSY_BUTTON_CLASS } from "@/components/agents-page/agents-tab/steps/busy-label";
import { Input } from "@/components/ui/input";
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
  SOCIAL_FIT,
  SOCIAL_DEFAULT_QUALITY,
  SOCIAL_DEFAULT_GRAPHICS_QUALITY,
  graphicsLosesSharpness,
} from "@/lib/export/quality";
import { ExportAudioSection } from "@/components/export/export-audio-section";
import {
  audioRequest,
  exportSummary,
  isIncluded,
  overridesAfterPurpose,
  type ExportAudioTrack,
  type ExportPurpose,
  type IncludeOverrides,
} from "@/components/export/audio-defaults";

/** The dialog offers no Custom UI (removed — API-only now), so its media
 *  quality state never takes the "custom" value. Narrowing the local state
 *  to this type lets `presetDimensions`/`resolveOutputDimensions` calls
 *  below skip re-litigating the custom-dims case. */
type DialogQuality = Exclude<ExportQuality, "custom">;

const QUALITY_LABEL: Record<DialogQuality, string> = { source: "Original", "1080p": "1080p", "1440p": "1440p", "4k": "4K" };

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
  /** Every track the export plays (addendum §7). */
  audioTracks?: ExportAudioTrack[];
  /** True while the piece's audio rights are still loading — an empty
   *  `audioTracks` here means "not known yet", never "no audio", so Export
   *  stays disabled and the Audio column shows a skeleton instead of the
   *  empty-piece message. */
  audioTracksLoading?: boolean;
  /** True when the piece's audio rights failed to load — Export stays
   *  disabled and the Audio column offers "Try again". */
  audioTracksError?: boolean;
  onRetryAudioTracks?: () => void;
  /** Preselects the purpose; Social when absent (never empty). */
  initialPurpose?: ExportPurpose | null;
  /** The composer sent the user here: once Start queues the export, close the
   *  dialog and take them back to the Posting tab, where the composer waits
   *  for that export. */
  returnToPost?: boolean;
  /** The draft that composer was editing: the way back reopens it. */
  returnDraftPostId?: string | null;
}

/**
 * Modal export dialog. It hosts the export form and nothing else: Start queues
 * an export and the dialog shows the form again with an "Export queued" banner
 * and a link to the Exports tab. Several exports can run at once; their
 * progress and finish are on each export's record (Exports tab, canvas bar,
 * finish toast), never here. Closing the dialog never affects an export.
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
    audioTracks = [],
    audioTracksLoading = false,
    audioTracksError = false,
    onRetryAudioTracks,
    initialPurpose,
    returnToPost = false,
    returnDraftPostId = null,
  } = props;

  const [innerOpen, setInnerOpen] = useState(false);
  const open = openOverride ?? innerOpen;

  const isTerminalFlow = flow.status === "queued" || flow.status === "failed";

  // When the dialog closes (any path: backdrop click, Esc, X button, our
  // Close button) AND the last Start has an outcome, reset the hook so the
  // next open shows the form fresh instead of a stale queued banner.
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next && isTerminalFlow) {
        flow.reset();
      }
      // Always keep the internal state in sync, even while `openOverride` is
      // driving `open` — a caller (preview-player.tsx) that only overrides
      // `open` WHILE true (undefined once closed, so the trigger reappears)
      // needs `innerOpen` to already read `false` the moment control reverts
      // to uncontrolled, or the dialog reopens itself showing a freshly reset
      // form instead of closing. Found live: clicking "Post…" reset the flow
      // (terminal → idle) and called onOpenChange(false), which flipped
      // `openOverride` to undefined next render — but `innerOpen` was still
      // stuck at `true` from before control took over, so `open` (`??`)
      // resolved true again and the dialog "reopened" onto its own idle form.
      setInnerOpen(next);
      // Always fire onOpenChange as a notification so a parent can observe
      // open/close even without taking over the open state (the post-close
      // success toast relies on knowing whether the dialog was closed when
      // the export finished).
      onOpenChange?.(next);
    },
    [isTerminalFlow, flow, onOpenChange],
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

  const [purpose, setPurposeState] = useState<ExportPurpose>(initialPurpose ?? "social");
  const [overrides, setOverrides] = useState<IncludeOverrides>({});
  // Whether the user picked a size. A social export they did not size is fitted by libi to at most
  // 1080×1920 (what Instagram and TikTok take) — the same default the agent path has — instead of
  // the saved export defaults, which may say 4K (221 MB / 144 s for one post). Picking any size ends it.
  const [sizeTouched, setSizeTouched] = useState(false);
  const socialFit = purpose === "social" && !sizeTouched;
  const choosePurpose = useCallback(
    (p: ExportPurpose) => {
      // Re-clicking the already-selected purpose is a no-op: it must not
      // wipe a copyrighted track's toggle. Only an actual purpose CHANGE
      // re-applies the copyrighted defaults.
      if (p === purpose) return;
      setPurposeState(p);
      setOverrides((o) => overridesAfterPurpose(audioTracks, o));
    },
    [purpose, audioTracks],
  );

  // `ExportDialog` is ONE long-lived instance (mounted once in
  // preview-player.tsx) — the `useState(initialPurpose ?? "social")` above
  // only ever seeds on this component's first-ever mount, so a later open
  // (e.g. the Posting tab's "Export & post", which passes a fresh
  // `initialPurpose` each time) never re-applied it, and whatever purpose
  // was last chosen carried into the next, unrelated export. Re-seed on the
  // closed→open edge only — same compare-in-render pattern as
  // `prevPieceName` / `prevDefaults` above — never while the dialog stays
  // open, so a purpose the user is actively choosing isn't clobbered
  // mid-session.
  const [presetUndo, setPresetUndo] = useState<{ format: ExportFormat } | null>(null);
  const [prevOpenForPurpose, setPrevOpenForPurpose] = useState(open);
  if (open !== prevOpenForPurpose) {
    setPrevOpenForPurpose(open);
    if (open) {
      setPurposeState(initialPurpose ?? "social");
      setOverrides({});
      setSizeTouched(false);
      if (returnToPost) {
        // From the post composer: Instagram and TikTok want MP4, and a social export is already
        // fitted to 1080×1920 (the size is not preset: `socialFit`). The user can still change
        // both; the saved export defaults are never written, and the format is put back for the
        // next plain open.
        if (!presetUndo) setPresetUndo({ format });
        setFormat("mp4");
      } else if (presetUndo) {
        setFormat(presetUndo.format);
        setPresetUndo(null);
      }
    }
  }

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
  // What the dialog shows and sends: the user's tiers, or — for a social export they did not size —
  // the social default (the piece's own media size, 1080p graphics) fitted into SOCIAL_FIT.
  const effQuality: DialogQuality = socialFit ? SOCIAL_DEFAULT_QUALITY : quality;
  const effGraphicsQuality: GraphicsQuality = socialFit ? SOCIAL_DEFAULT_GRAPHICS_QUALITY : graphicsQuality;
  const mediaDims = useMemo(() => {
    if (effQuality === "source") return { width: compositionWidth, height: compositionHeight };
    return presetDimensions(effQuality, compositionWidth, compositionHeight);
  }, [effQuality, compositionWidth, compositionHeight]);

  const mediaIsUpscaling = computeIsUpscaling(mediaDims, compositionWidth, compositionHeight);

  // The actual output frame — the larger of the media and (when the piece
  // has graphics) graphics tiers, per resolveOutputDimensions. Drives the
  // "Output W×H" hint on the media field.
  const outputDims = useMemo(
    () =>
      resolveOutputDimensions({
        quality: effQuality,
        graphicsQuality: effGraphicsQuality,
        hasGraphics,
        sourceWidth: compositionWidth,
        sourceHeight: compositionHeight,
        ...(socialFit ? { fitWithin: SOCIAL_FIT } : {}),
      }),
    [effQuality, effGraphicsQuality, hasGraphics, compositionWidth, compositionHeight, socialFit],
  );

  // Only warn when the text really comes out below 4K: media at 4K already
  // raises the frame there, whatever the graphics choice says.
  const fullGraphics = presetDimensions(DEFAULT_GRAPHICS_QUALITY, compositionWidth, compositionHeight);
  const graphicsWarning =
    !socialFit &&
    graphicsLosesSharpness(graphicsQuality) &&
    outputDims.width * outputDims.height < fullGraphics.width * fullGraphics.height;

  const starting = flow.status === "starting";

  const handleStart = useCallback(async () => {
    if (!pieceId) return;
    const stem = filename.trim() || pieceName?.trim() || "libi-export";
    const queued = await flow.start({
      pieceId,
      source,
      filename: stem,
      format,
      // A social export with no size picked names none: the server fits it to 1080×1920
      // (`usesSocialFit`), which is exactly the size shown above.
      ...(socialFit ? {} : {
        quality,
        // Sent even when hasGraphics is false — the server ignores it for a
        // graphics-free piece, and keeping it always-present means it never
        // silently drops out of the payload if graphics get added later.
        graphicsQuality,
      }),
      // `audioRequest` always carries a `purpose` ("social" by default), so
      // this dialog's own submissions can never draw the API's 422
      // `purpose_required` — that refusal (`flow.purposeRequired`) still
      // exists for callers that omit purpose (`app/api/export/route.ts`),
      // which is why the dialog no longer renders a line for it.
      ...audioRequest(audioTracks, purpose, overrides),
    });
    if (queued && returnToPost) {
      // The export belongs to the post being composed: hand it over and go
      // back to it. The Timeline tab (and this dialog with it) unmounts.
      markExportForPost(queued.exportId);
      openPostingTab({
        pieceId: queued.pieceId,
        awaitExportId: queued.exportId,
        ...(returnDraftPostId ? { providerPostId: returnDraftPostId } : {}),
      });
      setOpen(false);
    }
  }, [pieceId, filename, pieceName, flow, source, format, quality, graphicsQuality, socialFit, audioTracks, purpose, overrides, returnToPost, returnDraftPostId, setOpen]);

  const handleClose = useCallback(() => {
    // setOpen handles the reset for us.
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
              className="export-trigger export-trigger-idle group relative inline-flex cursor-pointer items-center overflow-hidden rounded-md px-3.5 py-1.5 text-xs font-semibold text-primary-foreground ring-1 ring-black/10 shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.22)] transition-all duration-150 hover:-translate-y-px hover:shadow-[0_4px_12px_-2px_color-mix(in_oklab,var(--primary)_70%,transparent),inset_0_1px_0_rgba(255,255,255,0.28)] active:translate-y-0 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none"
            >
              <span
                aria-hidden
                className="export-trigger-sheen pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-transparent via-white/35 to-transparent"
              />
              <span className="relative z-10 inline-flex items-center gap-1.5">
                <ExportIcon className="transition-transform duration-150 group-hover:translate-y-0.5" />
                Export
              </span>
            </button>
          }
        />
      )}

      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>
            Choose format and quality. The file is saved with the piece — find it in the Exports tab.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-2">
          <section data-testid="export-video-column" className="flex min-w-0 flex-col gap-4">
            <h3 className="text-sm font-medium">Video</h3>
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
                value={effQuality}
                onChange={(v) => {
                  setSizeTouched(true);
                  // Leaving the social default keeps the other tier where it was shown, so choosing one
                  // size does not silently swap the other for a saved default.
                  if (socialFit) setGraphicsQuality(effGraphicsQuality);
                  setQuality(v as DialogQuality);
                }}
                options={[
                  { value: "source", label: "Original" },
                  { value: "1080p", label: "1080p" },
                  { value: "1440p", label: "1440p" },
                  { value: "4k", label: "4K" },
                ]}
              />
              {socialFit && (
                <p data-testid="export-social-fit" className="mt-2 text-xs text-muted-foreground">
                  Fitted for social: at most {SOCIAL_FIT.shortEdge}×{SOCIAL_FIT.longEdge}, the most Instagram and TikTok take.
                  Pick a size to override.
                </p>
              )}
              {mediaIsUpscaling && (
                <p className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  {`Videos and images are upscaled from ${compositionWidth}×${compositionHeight}: no added detail, larger file.`}
                </p>
              )}
            </Field>

            {hasGraphics && (
              <Field label="Text, code & 3D">
                <Segmented
                  value={effGraphicsQuality}
                  onChange={(v) => {
                    setSizeTouched(true);
                    if (socialFit) setQuality(effQuality);
                    setGraphicsQuality(v as GraphicsQuality);
                  }}
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
          </section>

          <section data-testid="export-audio-column" className="flex min-w-0 flex-col gap-4">
            <h3 className="text-sm font-medium">Audio</h3>
            <ExportAudioSection
              tracks={audioTracks}
              purpose={purpose}
              onPurpose={choosePurpose}
              isOn={(t) => isIncluded(t, purpose, overrides)}
              onToggle={(id, on) => setOverrides((prev) => ({ ...prev, [id]: on }))}
              loading={audioTracksLoading}
              error={audioTracksError}
              onRetry={onRetryAudioTracks}
            />
          </section>

        </div>

        {flow.status === "failed" ? (
          <div className="rounded bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
            {flow.error ?? "Export failed."}
          </div>
        ) : null}

        {flow.status === "queued" && flow.queued ? (
          <div data-testid="export-queued" role="status" className="flex min-w-0 flex-col gap-1.5 rounded bg-emerald-500/10 p-3 text-xs">
            <div className="break-words font-medium text-emerald-700 dark:text-emerald-400">
              Export queued — see the Exports tab
            </div>
            <div className="truncate text-muted-foreground">{flow.queued.name}</div>
            <button
              type="button"
              className="cursor-pointer self-start text-xs underline"
              onClick={() => {
                const q = flow.queued;
                setOpen(false);
                if (q) openExportInTab({ pieceId: q.pieceId, exportId: q.exportId });
              }}
            >
              Open the Exports tab
            </button>
          </div>
        ) : null}

        <DialogFooter>
          {audioTracksLoading ? (
            <Skeleton data-testid="export-summary-loading" className="h-3 w-40 sm:mr-auto sm:self-center" />
          ) : (
            <span data-testid="export-summary" className="text-xs text-muted-foreground sm:mr-auto sm:self-center">
              {audioTracksError ? "Couldn't load this piece's audio" : exportSummary(format, socialFit ? `${outputDims.width}×${outputDims.height}` : QUALITY_LABEL[quality], audioTracks, purpose, overrides)}
            </span>
          )}
          <Button variant="ghost" onClick={handleClose} className="cursor-pointer">
            {flow.status === "queued" ? "Close" : "Cancel"}
          </Button>
          <Button
            onClick={handleStart}
            disabled={!pieceId || !filename.trim() || audioTracksLoading || audioTracksError || starting}
            focusableWhenDisabled={starting}
            className={`cursor-pointer ${BUSY_BUTTON_CLASS}`}
          >
            {starting ? <BusyLabel>Queuing…</BusyLabel> : "Export"}
          </Button>
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
