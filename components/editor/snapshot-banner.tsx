"use client";

import { useState } from "react";
import { useEditorState } from "@/lib/editor-state-context";
import { Button } from "@/components/ui/button";
import { Camera, X } from "lucide-react";

export function SnapshotBanner() {
  const { viewMode, setViewMode } = useEditorState();
  const [dismissed, setDismissed] = useState(false);

  // Reset dismiss state every time the user enters snapshot view so the banner
  // reappears when they leave and come back. Adjusted during render (React's
  // documented previous-state pattern) rather than in an effect — same result,
  // no post-commit cascading re-render.
  const [prevViewMode, setPrevViewMode] = useState(viewMode);
  if (viewMode !== prevViewMode) {
    setPrevViewMode(viewMode);
    if (viewMode === "snapshot") setDismissed(false);
  }

  if (viewMode !== "snapshot" || dismissed) return null;

  return (
    <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Camera className="h-3.5 w-3.5" />
        <span className="text-muted-foreground">
          Viewing snapshot. Switch to Draft to edit.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDismissed(true)}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setViewMode("draft")}
          className="cursor-pointer h-6 text-xs"
        >
          Switch to Draft
        </Button>
      </div>
    </div>
  );
}
