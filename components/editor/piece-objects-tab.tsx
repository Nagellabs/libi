"use client";

import { Package, Users } from "lucide-react";
import { usePieceCharacters, usePieceItems } from "@/lib/queries/catalog";
import { linkedAssetNames, type PieceLinkGroup } from "@/lib/catalog/piece-links";
import { Skeleton } from "@/components/ui/skeleton";
import { ObjectChip } from "./object-chip";

/** Merged per-piece "Objects" tab — Characters section stacked over an
 * Items section, both always visible. Replaces the old
 * piece-characters-tab / piece-items-tab pair; chip popovers replace the
 * old detail-page navigation. */
export function PieceObjectsTab({ pieceId }: { pieceId: string }) {
  const { data: charactersData, isLoading: charactersLoading } = usePieceCharacters(pieceId);
  const { data: itemsData, isLoading: itemsLoading } = usePieceItems(pieceId);

  const characterGroups: PieceLinkGroup[] =
    charactersData?.groups.map((g) => ({ file: g.file, entities: g.characters })) ?? [];
  const itemGroups: PieceLinkGroup[] =
    itemsData?.groups.map((g) => ({ file: g.file, entities: g.items })) ?? [];

  return (
    <div className="p-4 space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Characters</h3>
          <span className="text-xs text-muted-foreground">
            {charactersData ? new Set(charactersData.groups.flatMap((g) => g.characters.map((c) => c.id))).size : 0}
          </span>
        </div>
        {charactersLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : !charactersData || charactersData.groups.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No characters cataloged for this piece&apos;s assets yet. Ask your agent to catalog characters from your videos and images.
          </div>
        ) : (
          <div className="space-y-4">
            {charactersData.groups.map((g) => (
              <div key={g.file.id} className="rounded-lg border p-4">
                <div className="mb-2 text-sm font-medium">{g.file.name}</div>
                <div className="flex flex-wrap gap-2">
                  {g.characters.map((c) => (
                    <ObjectChip
                      key={c.id}
                      entity={c}
                      linkedAssetNames={linkedAssetNames(characterGroups, c.id)}
                      fallbackIcon={Users}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Items</h3>
          <span className="text-xs text-muted-foreground">
            {itemsData ? new Set(itemsData.groups.flatMap((g) => g.items.map((c) => c.id))).size : 0}
          </span>
        </div>
        {itemsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : !itemsData || itemsData.groups.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No items cataloged for this piece&apos;s assets yet. Ask your agent to catalog items from your videos and images.
          </div>
        ) : (
          <div className="space-y-4">
            {itemsData.groups.map((g) => (
              <div key={g.file.id} className="rounded-lg border p-4">
                <div className="mb-2 text-sm font-medium">{g.file.name}</div>
                <div className="flex flex-wrap gap-2">
                  {g.items.map((c) => (
                    <ObjectChip
                      key={c.id}
                      entity={c}
                      linkedAssetNames={linkedAssetNames(itemGroups, c.id)}
                      fallbackIcon={Package}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
