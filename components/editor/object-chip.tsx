"use client";

import type { LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { CharacterListItem } from "@/lib/queries/catalog";

interface ObjectChipProps {
  entity: CharacterListItem;
  linkedAssetNames: string[];
  fallbackIcon: LucideIcon;
}

/** Chip for a cataloged character/item. Clicking opens a centered modal
 * dialog so the representative image is shown in full (not clipped against
 * the viewport edge like an anchored popover). Replaces the old
 * `/characters/:id` / `/items/:id` detail-page navigation. All data comes
 * via props; the caller (piece-objects-tab) owns data fetching. */
export function ObjectChip({ entity, linkedAssetNames, fallbackIcon: FallbackIcon }: ObjectChipProps) {
  return (
    <Dialog>
      <DialogTrigger className="cursor-pointer flex items-center gap-2 rounded-full border border-border px-3 py-1 hover:bg-accent">
        {entity.representativeImageUrl ? (
          <img
            src={entity.representativeImageUrl}
            alt=""
            className="size-6 rounded-full object-cover"
          />
        ) : (
          <FallbackIcon className="size-4 text-muted-foreground" />
        )}
        <span className="text-sm">{entity.name}</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="pr-8 text-base font-semibold">{entity.name}</DialogTitle>
        <div className="flex flex-col gap-3">
          {entity.representativeImageUrl ? (
            <img
              src={entity.representativeImageUrl}
              alt={entity.name}
              className="max-h-[60vh] w-full rounded-lg bg-muted object-contain"
            />
          ) : (
            <div className="flex h-48 w-full items-center justify-center rounded-lg bg-muted">
              <FallbackIcon className="size-10 text-muted-foreground" />
            </div>
          )}
          {entity.description ? (
            <p className="text-sm text-muted-foreground">{entity.description}</p>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              In this piece
            </span>
            {linkedAssetNames.length > 0 ? (
              linkedAssetNames.map((name) => (
                <span key={name} className="truncate text-xs text-muted-foreground">
                  {name}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No linked assets</span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
