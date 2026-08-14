"use client";

import { useState } from "react";
import { useFiles, useGlobalFiles } from "@/lib/queries/files";
import { AssetThumbnail } from "./asset-thumbnail";
import type { StripTileDTO } from "@/lib/queries/snapshots";
import { Film, FileQuestion } from "lucide-react";

interface Props {
  pieceId: string;
  tiles: StripTileDTO[];
}

const BADGE: Record<StripTileDTO["changeKind"], { sym: string; cls: string } | null> = {
  added: { sym: "＋", cls: "bg-emerald-500/20 text-emerald-300" },
  changed: { sym: "~", cls: "bg-amber-500/20 text-amber-300" },
  removed: { sym: "−", cls: "bg-red-500/20 text-red-300" },
  unchanged: null,
};

function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** A tile id stable within one version's strip (a removed scene shares its
 *  scene id with no present tile, so id+changeKind is unique). */
const tileKey = (t: StripTileDTO) => `${t.id}-${t.changeKind}`;

const CHANGE_LABEL: Record<StripTileDTO["changeKind"], string> = {
  added: "added",
  changed: "changed",
  removed: "removed",
  unchanged: "unchanged",
};

export function VersionSceneStrip({ pieceId, tiles }: Props) {
  // A scene/overlay can reference a piece file OR a global file (uploaded with
  // no pieceId), so index both — otherwise a global-file scene would render as
  // a false "deleted file" tile even though the file exists.
  const { data: pieceFiles } = useFiles(pieceId);
  const { data: globalFiles } = useGlobalFiles();
  const byId = new Map(
    [...(pieceFiles ?? []), ...(globalFiles ?? [])].map((f) => [f.id, f]),
  );

  const [clickedKey, setClickedKey] = useState<string | null>(null);

  if (tiles.length === 0) {
    return <div className="text-xs text-muted-foreground">No scenes in this version.</div>;
  }

  // Default the detail line to the first scene so the reserved area is always
  // populated. A clicked tile (when it still exists in the current version)
  // wins; switching versions falls back to the first scene.
  const selected = tiles.find((t) => tileKey(t) === clickedKey) ?? tiles[0];

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {tiles.map((t) => {
          const badge = BADGE[t.changeKind];
          const file = t.fileId ? byId.get(t.fileId) : undefined;
          const missing = !!t.fileId && !file;
          const isSel = tileKey(t) === tileKey(selected);
          return (
            <button
              key={tileKey(t)}
              onClick={() => setClickedKey(tileKey(t))}
              title={`${t.name} · ${fmtDur(t.duration)}${missing ? " · file deleted" : ""}`}
              className={`relative w-40 cursor-pointer overflow-hidden rounded-md border text-left transition ${
                t.changeKind === "removed" ? "opacity-50 grayscale" : ""
              } ${isSel ? "border-primary ring-2 ring-primary" : "hover:border-foreground/30"}`}
            >
              <div className="aspect-video w-full bg-black/30">
                {file ? (
                  <AssetThumbnail file={file} />
                ) : missing ? (
                  <div className="flex h-full w-full items-center justify-center text-red-400">
                    <FileQuestion className="h-8 w-8" />
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    <Film className="h-8 w-8" />
                  </div>
                )}
              </div>
              {badge && (
                <span className={`absolute left-1 top-1 rounded px-1 text-[10px] font-bold ${badge.cls}`}>
                  {badge.sym}
                </span>
              )}
              <div className="line-clamp-2 px-1.5 py-1 text-xs text-muted-foreground">
                {t.name}
              </div>
            </button>
          );
        })}
      </div>

      {/* Reserved detail line for the focused scene — always rendered (fixed
          min-height) so showing/hiding it never shifts the layout. */}
      <div className="mt-3 min-h-[2.75rem] rounded-md border bg-muted/30 px-3 py-1.5">
        <div className="break-words text-sm font-medium">{selected.name}</div>
        <div className="text-xs text-muted-foreground">
          {selected.type} scene · {fmtDur(selected.duration)}
          {selected.changeKind !== "unchanged" ? ` · ${CHANGE_LABEL[selected.changeKind]}` : ""}
          {!!selected.fileId && !byId.get(selected.fileId) ? " · file deleted" : ""}
        </div>
      </div>
    </div>
  );
}
