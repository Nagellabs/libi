"use client";

import { useState } from "react";
import type { StoryboardCard, GenParamValue } from "@/lib/storyboard/types";
import { AudioChip } from "./audio-chip";
import { MediaViewer } from "@/components/storyboard/media-viewer";

interface AudioRowProps {
  card: StoryboardCard;
  orderByCardId: Record<string, number>;
  onEditParam?: (key: string, value: GenParamValue | null) => void;
}

function inheritedBadge(
  card: StoryboardCard,
  key: string,
  orderByCardId: Record<string, number>,
): string | undefined {
  const ref = card.inheritedRefs?.[key];
  if (!ref) return undefined;
  const n = (orderByCardId[ref.fromCardId] ?? 0) + 1;
  return `from sc.${String(n).padStart(2, "0")}`;
}

const KEY = "audio_ref";

export function AudioRow({
  card,
  orderByCardId,
  onEditParam,
}: AudioRowProps) {
  const [viewerOpen, setViewerOpen] = useState(false);

  const params = card.clipGen?.params ?? {};
  const value = params[KEY];
  const fileId = typeof value === "string" && value ? value : null;
  const editable = !!onEditParam;

  // Display-only — adding is handled by the unified "Add reference" menu.
  if (!fileId) return null;

  const badge = inheritedBadge(card, KEY, orderByCardId);
  const src = `/api/files/by-id/${fileId}/content`;

  return (
    <div>
      {/* Group label */}
      <div className="text-[11px] text-muted-foreground mb-1.5">Audio</div>

      <div className="flex flex-wrap gap-2 items-center">
        <AudioChip
          src={src}
          label="audio ref"
          inherited={!!card.inheritedRefs?.[KEY]}
          badge={badge}
          onView={() => setViewerOpen(true)}
          onRemove={editable ? () => onEditParam!(KEY, null) : undefined}
        />
      </div>

      <MediaViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        src={src}
        kind="audio"
        title={`Audio ref — ${card.title}`}
      />
    </div>
  );
}
