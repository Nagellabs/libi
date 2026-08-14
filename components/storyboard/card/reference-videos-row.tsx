"use client";

import { useState } from "react";
import type { StoryboardCard, GenParamValue } from "@/lib/storyboard/types";
import { MediaTile } from "./media-tile";
import { MediaViewer } from "@/components/storyboard/media-viewer";

interface ReferenceVideosRowProps {
  card: StoryboardCard;
  orderByCardId: Record<string, number>;
  onEditParam?: (key: string, value: GenParamValue | null) => void;
  onSetReference?: (key: string, fromCardId: string | null) => void;
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

const KEY = "reference_video";

export function ReferenceVideosRow({
  card,
  orderByCardId,
  onEditParam,
  onSetReference,
}: ReferenceVideosRowProps) {
  const [viewerOpen, setViewerOpen] = useState(false);

  const params = card.clipGen?.params ?? {};
  const value = params[KEY];
  const fileId = typeof value === "string" && value ? value : null;
  const editable = !!onEditParam || !!onSetReference;
  const isInherited = !!card.inheritedRefs?.[KEY];

  // Display-only — adding/replacing a reference is handled by the unified
  // "Add reference" menu on the card.
  if (!fileId) return null;

  const badge = inheritedBadge(card, KEY, orderByCardId);
  const src = `/api/files/by-id/${fileId}/content`;

  const removeRef = () => {
    if (isInherited) onSetReference?.(KEY, null);
    else onEditParam?.(KEY, null);
  };

  return (
    <div>
      {/* Group label */}
      <div className="text-[11px] text-muted-foreground mb-1.5">Reference videos</div>

      <div className="flex flex-wrap items-start gap-3">
        <MediaTile
          kind="video"
          width={88}
          src={src}
          inherited={isInherited}
          badge={badge}
          onView={() => setViewerOpen(true)}
          onRemove={editable ? removeRef : undefined}
        />
      </div>

      <MediaViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        src={src}
        kind="video"
        title={`Reference video — ${card.title}`}
      />
    </div>
  );
}
