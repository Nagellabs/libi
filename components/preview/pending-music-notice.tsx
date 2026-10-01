"use client";

import { usePieceComposition } from "@/lib/queries/pieces";
import { songLabel } from "@/lib/audio-rights/types";

/** A template's song that was left out of this piece (social-music spec §7). */
export function PendingMusicNotice({ pieceId }: { pieceId: string }) {
  const q = usePieceComposition(pieceId);
  const pending = q.data?.manifest.pendingMusic ?? [];
  if (pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 px-1 py-0.5">
      {pending.map((p) => (
        <p key={p.assetId} data-testid="pending-music-notice" className="text-[11px] text-amber-600 dark:text-amber-400">
          Music not included: <bdi>{songLabel(p.track)}</bdi>
        </p>
      ))}
    </div>
  );
}
