"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Maximize2, Minimize2, MessageSquare, Folder, X, type LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useEditorState } from "@/lib/editor-state-context";
import type { FileRecord } from "@/lib/db/schema/types";
import { AssetMediaView } from "./asset-media-view";
import { AnalysisSummaryPanel } from "./analysis-summary-panel";
import { TranscriptView, FramesTabContent, StepStateGate, StepIcon } from "./analysis-viewer";
import { ScriptTabContent } from "./script-tab-content";
import { findLatestScriptStep } from "@/lib/analysis/scripts";
import { useVideoAnalysis } from "@/lib/queries/analysis";
import { useUpdateFileNotes } from "@/lib/queries/files";
import { GenerationTabContent } from "./generation-tab-content";
import { cn } from "@/lib/utils";

/**
 * Notes tab body. Full-width, always-open textarea (no collapsed state — the
 * tab itself is the affordance). Replaces the inline header editor that was
 * crowding the panel chrome. Notes are primarily read by the agent for
 * file-lineage breadcrumbs (model, retry, validation), so giving them their
 * own tab keeps the header tidy without losing access.
 */
function FileNotesTabBody({ file }: { file: { id: string; notes: string | null } }) {
  const [text, setText] = useState(file.notes ?? "");
  const update = useUpdateFileNotes();

  // Sync in an external notes update (e.g. the agent appended a line) on the
  // render where it arrives — previous-state pattern, no effect cascade.
  const [prevNotes, setPrevNotes] = useState(file.notes);
  if (file.notes !== prevNotes) {
    setPrevNotes(file.notes);
    setText(file.notes ?? "");
  }

  const save = () => {
    if (text !== (file.notes ?? "")) {
      update.mutate({ fileId: file.id, notes: text, mode: "replace" });
    }
  };

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="text-xs text-muted-foreground">
        Agent-facing breadcrumbs (model, retry index, parent file id, prompt
        hash, validation summary). Each save by `libi.update_file_notes`
        appends one timestamped line; this editor replaces the whole field
        when you save.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        rows={20}
        className="block w-full resize-y rounded border bg-background p-2 font-mono text-xs leading-relaxed shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder="Agent breadcrumbs (model, retry, validation)…"
      />
    </div>
  );
}

type AssetTab = "preview" | "summary" | "transcript" | "frames" | "script" | "generation" | "notes";

interface Props {
  asset: FileRecord;
  onClose: () => void;
  chatOpen?: boolean;
  resourcesOpen?: boolean;
  onToggleChat?: () => void;
  onToggleResources?: () => void;
}

function HeaderToggleButton({
  icon: Icon,
  active,
  title,
  onClick,
}: {
  icon: LucideIcon;
  active: boolean;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "cursor-pointer flex size-7 items-center justify-center rounded-md transition-colors",
        active
          ? "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          : "bg-muted border border-border text-foreground hover:bg-surface-hover",
      )}
      aria-pressed={active}
    >
      <Icon className="size-3.5" strokeWidth={1.8} />
    </button>
  );
}

export function AssetPreviewPanel({
  asset,
  onClose,
  chatOpen,
  resourcesOpen,
  onToggleChat,
  onToggleResources,
}: Props) {
  const {
    assetPanelSplit,
    setAssetPanelSplit,
    getAssetViewMode,
    setAssetViewMode,
    lastAssetTab,
    setLastAssetTab,
  } = useEditorState();

  // Per-asset view mode: split (default) or full. Switching to a different
  // asset re-derives from storage so each asset remembers its own preference.
  const assetFullMode = getAssetViewMode(asset.id) === "full";

  // Initial tab: prefer the last tab the user was on (`lastAssetTab`) if it's
  // valid for the current view mode. Split mode can't show "preview", so
  // fall back to "summary" in that case.
  const [activeTab, setActiveTab] = useState<AssetTab>(() => {
    if (!assetFullMode && lastAssetTab === "preview") return "summary";
    return lastAssetTab;
  });

  // When the user opens a different asset, snap the active tab back to a sane
  // default for that asset's stored mode (full → preview, split → summary).
  // This also handles the toggling case below. Adjusted during render
  // (previous-state pattern) — each branch is self-limiting, no effect cascade.
  const [prevPanelAssetId, setPrevPanelAssetId] = useState(asset.id);
  if (asset.id !== prevPanelAssetId) {
    setPrevPanelAssetId(asset.id);
    setActiveTab(
      assetFullMode
        ? "preview"
        : lastAssetTab === "preview"
          ? "summary"
          : lastAssetTab,
    );
  } else if (!assetFullMode && activeTab === "preview") {
    // Same asset: only adjust if the user toggled out of full mode while on
    // the Preview tab — Preview is unreachable in split mode.
    setActiveTab("summary");
  }

  // Persist the active tab whenever it changes so the next mount restores it.
  useEffect(() => {
    setLastAssetTab(activeTab);
  }, [activeTab, setLastAssetTab]);

  // ── Media (video or audio) / time ───────────────────────────────────
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const seek = useCallback((t: number) => {
    const m = mediaRef.current;
    if (!m) return;
    m.currentTime = Math.max(0, t);
    if (m.paused) m.play().catch(() => {});
  }, []);

  const handleLayoutChanged = useCallback(
    (layout: { [id: string]: number }) => {
      const top = layout.top;
      if (typeof top === "number" && top > 5 && top < 95) {
        setAssetPanelSplit(top);
      }
    },
    [setAssetPanelSplit],
  );

  return (
    <div data-testid="asset-preview-panel" className="flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 h-[46px] shrink-0">
        {onToggleChat && (
          <>
            <HeaderToggleButton
              icon={MessageSquare}
              active={!!chatOpen}
              title={chatOpen ? "Hide chat" : "Show chat"}
              onClick={onToggleChat}
            />
            <div className="h-4 w-px bg-border" />
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to folder"
          title="Back to folder"
          className="cursor-pointer flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
        >
          <X className="size-3.5" strokeWidth={1.8} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-semibold text-foreground truncate">
            {asset.name || asset.filename}
          </div>
          {asset.contentType && (
            <div className="text-[11px] text-muted-foreground truncate">
              {asset.contentType}
            </div>
          )}
        </div>
        {onToggleResources && (
          <HeaderToggleButton
            icon={Folder}
            active={!!resourcesOpen}
            title={resourcesOpen ? "Hide resources" : "Show resources"}
            onClick={onToggleResources}
          />
        )}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AssetTab)} className="flex flex-1 min-h-0 flex-col gap-0">
        <div className="flex items-center justify-between border-b border-border bg-muted px-3">
          <TabsList className="bg-transparent">
            {assetFullMode && <TabsTrigger value="preview">Preview</TabsTrigger>}
            <TabsTrigger value="summary">
              Summary <TabTriggerWithIcon asset={asset} kind="summary" />
            </TabsTrigger>
            <TabsTrigger value="transcript">
              Transcript <TabTriggerWithIcon asset={asset} kind="transcript" />
            </TabsTrigger>
            <TabsTrigger value="frames">
              Frames <TabTriggerWithIcon asset={asset} kind="frames" />
            </TabsTrigger>
            {/* Tab value stays "script" (persisted via lastAssetTab); only the
                label changed — "Script" collided with the piece-level Script tab. */}
            <TabsTrigger value="script">
              Extra analysis <TabTriggerWithIcon asset={asset} kind="script" />
            </TabsTrigger>
            {asset.aiGeneration && (
              <TabsTrigger value="generation">Generation</TabsTrigger>
            )}
            <TabsTrigger value="notes">Notes</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setAssetViewMode(asset.id, assetFullMode ? "split" : "full")
              }
              aria-label={assetFullMode ? "Exit full mode" : "Full mode"}
              title={assetFullMode ? "Exit full mode" : "Full mode"}
              className="cursor-pointer flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            >
              {assetFullMode ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          {assetFullMode ? (
            <FullModeBody
              asset={asset}
              mediaRef={mediaRef}
              onTimeUpdate={setCurrentTime}
              onSeek={seek}
              currentTime={currentTime}
            />
          ) : (
            <Group
              orientation="vertical"
              defaultLayout={{ top: assetPanelSplit, bottom: 100 - assetPanelSplit }}
              onLayoutChanged={handleLayoutChanged}
              className="h-full"
            >
              <Panel id="top" minSize={15}>
                <div className="h-full">
                  <AssetMediaView
                    asset={asset}
                    mediaRef={mediaRef}
                    onTimeUpdate={setCurrentTime}
                  />
                </div>
              </Panel>
              <Separator className="group relative h-px bg-border transition-colors hover:bg-primary/60 data-[active]:bg-primary">
                <div className="absolute inset-x-0 -top-1 -bottom-1 z-10 group-hover:cursor-row-resize" />
              </Separator>
              <Panel id="bottom" minSize={15}>
                <div className="h-full overflow-auto">
                  <AnalysisTabsBody asset={asset} onSeek={seek} currentTime={currentTime} />
                </div>
              </Panel>
            </Group>
          )}
        </div>
      </Tabs>
    </div>
  );
}

function FullModeBody({
  asset,
  mediaRef,
  onTimeUpdate,
  onSeek,
  currentTime,
}: {
  asset: FileRecord;
  mediaRef: React.RefObject<HTMLMediaElement | null>;
  onTimeUpdate: (t: number) => void;
  onSeek: (t: number) => void;
  currentTime: number;
}) {
  return (
    <div className="h-full overflow-auto">
      <TabsContent value="preview" keepMounted className="h-full m-0">
        <AssetMediaView asset={asset} mediaRef={mediaRef} onTimeUpdate={onTimeUpdate} />
      </TabsContent>
      <AnalysisTabsBody asset={asset} onSeek={onSeek} currentTime={currentTime} />
    </div>
  );
}

// Bottom-panel content in default mode (and reused in full mode).
// Renders Summary, Transcript, and Frames tabs.
function AnalysisTabsBody({
  asset,
  onSeek,
  currentTime,
}: {
  asset: FileRecord;
  onSeek: (t: number) => void;
  currentTime: number;
}) {
  const { data } = useVideoAnalysis(asset.id);
  const byKind = data?.byKind ?? {};
  const summary = data?.summary ?? null;
  return (
    <>
      <TabsContent value="summary" className="px-4 py-3 m-0">
        <StepStateGate step={byKind.summary} kind="summary">
          <AnalysisSummaryPanel summary={summary} onSeek={onSeek} />
        </StepStateGate>
      </TabsContent>
      <TabsContent value="transcript" className="px-4 py-3 m-0">
        <StepStateGate step={byKind.transcript} kind="transcript">
          <TranscriptView
            step={data?.transcript ?? undefined}
            sentences={data?.transcriptSentences ?? null}
            onSeek={onSeek}
            currentTime={currentTime}
          />
        </StepStateGate>
      </TabsContent>
      <TabsContent value="frames" className="px-4 py-3 m-0">
        <StepStateGate step={byKind.frames} kind="frames">
          <FramesTabContent
            fileId={asset.id}
            framesWithDesc={data?.framesWithDesc ?? []}
            onSeek={onSeek}
          />
        </StepStateGate>
      </TabsContent>
      <TabsContent value="script" className="m-0 h-full">
        <ScriptTabContent
          fileId={asset.id}
          fileName={asset.name || asset.filename}
          onSeek={onSeek}
          currentTime={currentTime}
        />
      </TabsContent>
      {asset.aiGeneration && (
        <TabsContent value="generation" className="m-0">
          <GenerationTabContent file={asset} />
        </TabsContent>
      )}
      <TabsContent value="notes" className="m-0">
        <FileNotesTabBody file={asset} />
      </TabsContent>
    </>
  );
}

function TabTriggerWithIcon({
  asset,
  kind,
}: {
  asset: FileRecord;
  kind: "transcript" | "summary" | "frames" | "script";
}) {
  const { data } = useVideoAnalysis(asset.id);
  const step =
    kind === "script"
      ? findLatestScriptStep(data?.steps)
      : data?.byKind?.[kind];
  return <StepIcon step={step} />;
}
