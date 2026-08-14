"use client";

import { type ReactNode } from "react";
import { MessageSquare, Folder } from "lucide-react";
import { useReactRenderTelemetry } from "@/lib/preview/telemetry";
import type { FileRecord } from "@/lib/db/schema/types";
import { AssetExplorer } from "./asset-explorer";
import { PieceObjectsTab } from "./piece-objects-tab";
import { StoryboardTab } from "@/components/storyboard/storyboard-tab";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { HeaderToggleButton } from "./header-toggle-button";
import { SnapshotBanner } from "./snapshot-banner";
import { SnapshotDraftSwitcher } from "./snapshot-draft-switcher";

type PieceTab = "preview" | "storyboard" | "assets" | "objects";

interface EditorPanelProps {
  activeTab: PieceTab;
  onTabChange: (tab: PieceTab) => void;
  onSelectAsset: (file: FileRecord) => void;
  piece?: { name: string; description?: string | null } | null;
  chatOpen?: boolean;
  resourcesOpen?: boolean;
  onToggleChat?: () => void;
  onToggleResources?: () => void;
  /** The whole preview area (canvas + timeline), owned by <PreviewSurface>. */
  previewArea: ReactNode;
  pieceId: string;
}

export default function EditorPanel({
  activeTab,
  onTabChange,
  onSelectAsset,
  piece,
  chatOpen,
  resourcesOpen,
  onToggleChat,
  onToggleResources,
  previewArea,
  pieceId,
}: EditorPanelProps) {
  useReactRenderTelemetry("EditorPanel");
  const title = piece?.name ?? "Untitled";
  const subtitle = piece?.description ?? "";

  return (
    <div data-testid="editor-panel" className="flex h-full flex-col bg-surface">
      {/* Snapshot banner — shown above everything when viewMode === "snapshot" */}
      <SnapshotBanner />

      {/* Header: [chat-toggle] | title/subtitle | [switcher] [resources-toggle] */}
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
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-semibold text-foreground truncate">
            {title}
          </div>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground truncate">
              {subtitle}
            </div>
          )}
        </div>
        <div>
          <SnapshotDraftSwitcher pieceId={pieceId} />
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

      {/*
        Tabs — same shadcn `Tabs` component the asset preview uses, so the
        piece-mode and asset-mode tab rows look and behave identically.
      */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as PieceTab)}
        className="flex flex-1 min-h-0 flex-col gap-0"
      >
        <div className="flex items-center border-b border-border bg-muted px-3">
          <TabsList className="bg-transparent">
            <TabsTrigger value="preview">Timeline</TabsTrigger>
            <TabsTrigger value="storyboard">Storyboard</TabsTrigger>
            <TabsTrigger value="assets">Assets</TabsTrigger>
            <TabsTrigger value="objects">Objects</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="preview" className="flex flex-1 min-h-0 flex-col m-0">
          {previewArea}
        </TabsContent>
        <TabsContent value="storyboard" className="flex-1 min-h-0 overflow-auto m-0">
          <StoryboardTab pieceId={pieceId} />
        </TabsContent>
        <TabsContent value="assets" className="flex-1 min-h-0 overflow-auto m-0">
          <AssetExplorer pieceId={pieceId} onSelect={onSelectAsset} />
        </TabsContent>
        <TabsContent value="objects" className="flex-1 min-h-0 overflow-auto m-0">
          <PieceObjectsTab pieceId={pieceId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
