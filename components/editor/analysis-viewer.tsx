"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { CheckCircle2Icon, AlertCircleIcon, CopyIcon } from "lucide-react";
import { useVideoAnalysis, useSearchFrames } from "@/lib/queries/analysis";
import type { AnalysisStep, AnalysisStepKind, AnalysisKeyframe } from "@/lib/analysis/types";
import type { FrameDescription, TranscriptSentence } from "@/lib/analysis/types";
import { AnalysisSummaryPanel } from "./analysis-summary-panel";
import { AnalysisFrameDrawer } from "./analysis-frame-drawer";

// Standalone viewer that renders all three analysis tabs for a file. The
// actual asset-preview UI uses StepStateGate / StepIcon directly via
// asset-preview-panel.tsx — this component is the canonical integration
// surface (used by tests and any future contexts that want a self-contained
// analysis view).
interface AnalysisViewerProps {
  fileId: string;
  onSeek?: (timeSeconds: number) => void;
  currentTime?: number;
}

export function AnalysisViewer({ fileId, onSeek, currentTime }: AnalysisViewerProps) {
  const { data, isLoading } = useVideoAnalysis(fileId);
  const [tab, setTab] = useState("summary");

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const byKind = data?.byKind ?? {};
  const summary = data?.summary ?? null;
  const transcript = data?.transcript ?? null;
  const framesWithDesc = data?.framesWithDesc ?? [];
  const staleKeyframeIds = data?.staleKeyframeIds ?? [];

  return (
    <div className="border-t">
      {staleKeyframeIds.length > 0 && (
        <header className="px-4 py-2 text-xs">
          <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-yellow-600 dark:text-yellow-400">
            {staleKeyframeIds.length} frame
            {staleKeyframeIds.length !== 1 ? "s" : ""} stale (source video changed)
          </span>
        </header>
      )}
      <Tabs value={tab} onValueChange={setTab} className="px-4 pb-4">
        <TabsList>
          <TabsTrigger value="summary" className="cursor-pointer">
            Summary <StepIcon step={byKind.summary} />
          </TabsTrigger>
          <TabsTrigger value="transcript" className="cursor-pointer">
            Transcript <StepIcon step={byKind.transcript} />
          </TabsTrigger>
          <TabsTrigger value="frames" className="cursor-pointer">
            Frames {framesWithDesc.length > 0 && `(${framesWithDesc.length})`} <StepIcon step={byKind.frames} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="mt-3">
          <StepStateGate step={byKind.summary} kind="summary">
            <AnalysisSummaryPanel summary={summary} onSeek={onSeek} />
          </StepStateGate>
        </TabsContent>
        <TabsContent value="transcript" className="mt-3">
          <StepStateGate step={byKind.transcript} kind="transcript">
            <TranscriptView
              step={transcript ?? undefined}
              sentences={data?.transcriptSentences ?? null}
              onSeek={onSeek}
              currentTime={currentTime ?? 0}
            />
          </StepStateGate>
        </TabsContent>
        <TabsContent value="frames" className="mt-3">
          <StepStateGate step={byKind.frames} kind="frames">
            <FramesTabContent
              fileId={fileId}
              framesWithDesc={framesWithDesc}
              onSeek={onSeek}
            />
          </StepStateGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-step gate — handles not_started / failed states uniformly
// ──────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<AnalysisStepKind, string> = {
  transcript: "transcript",
  summary: "summary",
  frames: "frames",
};

export function StepStateGate({
  step,
  kind,
  children,
}: {
  step: AnalysisStep | undefined;
  kind: AnalysisStepKind;
  children: React.ReactNode;
}) {
  if (!step || step.status === "not_started") {
    return (
      <p className="text-sm text-muted-foreground">
        No {KIND_LABEL[kind]} yet. Ask the agent to {kind === "frames" ? "extract keyframes" : `produce a ${KIND_LABEL[kind]}`} for this video.
      </p>
    );
  }
  if (step.status === "failed") {
    return <FailedBanner step={step} kind={kind} />;
  }
  return <>{children}</>;
}

function FailedBanner({ step, kind }: { step: AnalysisStep; kind: AnalysisStepKind }) {
  const msg = step.errorMessage ?? "unknown error";
  return (
    <div className="space-y-2 rounded border border-red-500/40 bg-red-500/5 p-3 text-sm">
      <p className="font-medium text-red-500">
        {KIND_LABEL[kind].charAt(0).toUpperCase() + KIND_LABEL[kind].slice(1)} failed
      </p>
      <p className="text-muted-foreground">{msg}</p>
      <p className="text-xs text-muted-foreground">
        Ask the agent to retry, or paste the error above.
      </p>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(msg)}
        className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <CopyIcon className="size-3" /> Copy error
      </button>
    </div>
  );
}

export function StepIcon({ step }: { step: AnalysisStep | undefined }) {
  if (!step || step.status === "not_started") return null;
  if (step.status === "ready") {
    return <CheckCircle2Icon className="ml-1 inline size-3 text-emerald-500/70" aria-label="ready" />;
  }
  return <AlertCircleIcon className="ml-1 inline size-3 text-red-500" aria-label="failed" />;
}

// ──────────────────────────────────────────────────────────────────────────────
// Frames tab — search + grid + drawer
// ──────────────────────────────────────────────────────────────────────────────

interface FramesTabContentProps {
  fileId: string;
  framesWithDesc: Array<{ keyframe: AnalysisKeyframe; description: FrameDescription | null }>;
  onSeek?: (t: number) => void;
}

export function FramesTabContent({ fileId, framesWithDesc, onSeek }: FramesTabContentProps) {
  const [searchText, setSearchText] = useState("");
  const [debouncedText, setDebouncedText] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [openFrameIndex, setOpenFrameIndex] = useState<number | null>(null);

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setSearchText(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedText(val), 300);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const searchEnabled = debouncedText.trim().length > 0;
  const { data: searchData } = useSearchFrames(
    fileId,
    { text_contains: debouncedText.trim() },
    searchEnabled,
  );

  const displayedFrames = useMemo(() => {
    if (!searchEnabled) return framesWithDesc;
    if (!searchData?.matches) return [];
    const matchIds = new Set(searchData.matches.map((m) => m.keyframeId));
    return framesWithDesc.filter((f) => matchIds.has(f.keyframe.id));
  }, [framesWithDesc, searchEnabled, searchData]);

  const openFrame = openFrameIndex !== null ? framesWithDesc[openFrameIndex] ?? null : null;

  if (framesWithDesc.length === 0) {
    return <p className="text-sm text-muted-foreground">No keyframes saved.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Input
          type="search"
          placeholder="Search frames by text on screen…"
          value={searchText}
          onChange={handleSearchChange}
          className="h-8 text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {searchEnabled
          ? `Showing ${displayedFrames.length} of ${framesWithDesc.length} frames`
          : `${framesWithDesc.length} frame${framesWithDesc.length !== 1 ? "s" : ""}`}
      </p>
      {displayedFrames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No frames match your search</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {displayedFrames.map((frame) => {
            const { keyframe, description } = frame;
            const ts = keyframe.timestamp;
            const originalIndex = framesWithDesc.indexOf(frame);

            let caption: React.ReactNode;
            if (description?.scene) {
              caption = description.scene;
            } else if (keyframe.skipped) {
              caption = `skipped: ${keyframe.skipReason ?? "no reason"}`;
            } else {
              caption = <span className="opacity-60">no description</span>;
            }

            return (
              <figure key={keyframe.id} className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setOpenFrameIndex(originalIndex);
                    onSeek?.(ts);
                  }}
                  className="block w-full cursor-pointer overflow-hidden rounded border bg-muted hover:opacity-80"
                  title={`Seek to ${ts.toFixed(2)}s`}
                >
                  <img
                    src={`/api/files/by-id/${fileId}/analysis/frames/${keyframe.filePath}`}
                    alt={description?.scene ?? "keyframe"}
                    className="block h-auto w-full"
                  />
                </button>
                <figcaption className="text-xs text-muted-foreground">
                  <span className="mr-1 font-mono">{formatTimecode(ts)}</span>
                  {caption}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      {openFrame && (
        <AnalysisFrameDrawer
          keyframe={openFrame.keyframe}
          description={openFrame.description}
          fileId={fileId}
          onClose={() => setOpenFrameIndex(null)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Transcript view (unchanged behaviorally — input shape rename only)
// ──────────────────────────────────────────────────────────────────────────────

interface TranscriptViewProps {
  step?: AnalysisStep;
  sentences: TranscriptSentence[] | null;
  onSeek?: (t: number) => void;
  currentTime?: number;
}

const SPEAKER_HUES = [
  "bg-sky-500/15 text-sky-300",
  "bg-emerald-500/15 text-emerald-300",
  "bg-amber-500/15 text-amber-300",
  "bg-fuchsia-500/15 text-fuchsia-300",
  "bg-cyan-500/15 text-cyan-300",
  "bg-rose-500/15 text-rose-300",
];

function speakerHue(speakerId: string | null): string {
  if (speakerId === null) return "bg-muted text-muted-foreground";
  let h = 0;
  for (let i = 0; i < speakerId.length; i++) h = (h * 31 + speakerId.charCodeAt(i)) >>> 0;
  return SPEAKER_HUES[h % SPEAKER_HUES.length];
}

export function TranscriptView({ step, sentences, onSeek, currentTime = 0 }: TranscriptViewProps) {
  const activeIndex = useMemo<number | null>(() => {
    if (!sentences || sentences.length === 0) return null;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.start <= currentTime && currentTime < s.end) return i;
    }
    return null;
  }, [sentences, currentTime]);

  const isMultiSpeaker = useMemo(() => {
    if (!sentences) return false;
    const ids = new Set(sentences.map((s) => s.speakerId));
    return ids.size >= 2;
  }, [sentences]);

  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const prevActiveIndex = useRef<number | null>(null);

  useEffect(() => {
    if (activeIndex === null) {
      prevActiveIndex.current = null;
      return;
    }
    if (activeIndex === prevActiveIndex.current) return;
    prevActiveIndex.current = activeIndex;
    const el = rowRefs.current.get(activeIndex);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeIndex]);

  if (!step) return <p className="text-sm text-muted-foreground">No transcript yet</p>;

  const hasSentences = sentences !== null && sentences.length > 0;

  return (
    <div className="space-y-4">
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{step.content ?? ""}</p>
      {hasSentences && (
        <div className="mt-4 border-t pt-4">
          <table className="w-full text-sm">
            <tbody>
              {sentences!.map((sentence, i) => {
                const isActive = i === activeIndex;
                const speakerLabel = sentence.speakerId ?? "unknown";
                const hue = speakerHue(sentence.speakerId);
                return (
                  <tr
                    key={i}
                    ref={(el) => {
                      if (el) rowRefs.current.set(i, el);
                      else rowRefs.current.delete(i);
                    }}
                    data-active={isActive ? "true" : undefined}
                    className={`group${isActive ? " bg-primary/10" : ""}`}
                  >
                    <td className="w-14 align-top">
                      <button
                        type="button"
                        onClick={() => onSeek?.(sentence.start)}
                        className="w-full cursor-pointer rounded py-1 text-left font-mono text-xs tabular-nums text-muted-foreground hover:bg-muted/50 group-hover:bg-muted/50"
                        title={`Seek to ${sentence.start.toFixed(2)}s`}
                      >
                        {formatTimecode(sentence.start)}
                      </button>
                    </td>
                    {isMultiSpeaker && (
                      <td className="whitespace-nowrap px-2 py-1 align-top">
                        <span
                          data-testid="speaker-badge"
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${hue}`}
                        >
                          {speakerLabel}
                        </span>
                      </td>
                    )}
                    <td className="py-1 pl-2 align-top">
                      <button
                        type="button"
                        onClick={() => onSeek?.(sentence.start)}
                        className="w-full cursor-pointer rounded py-0.5 text-left text-sm hover:bg-muted/50 group-hover:bg-muted/50"
                      >
                        {sentence.text}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatTimecode(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
