"use client";

import { useFiles } from "@/lib/queries/files";
import { useAssetFolderList } from "@/lib/queries/asset-folders";
import type { FileRecord } from "@/lib/db/schema/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import AssetFolderTree from "./asset-folder-tree";
import { type SortOption } from "./sort-utils";

interface PieceAssetsProps {
  pieceId: string;
  onSelectAsset: (file: FileRecord) => void;
  onContextMenu: (e: React.MouseEvent, type: "piece" | "asset", pieceId: string | null, fileId?: string, name?: string) => void;
  renamingFileId: string | null;
  onRenameFileSubmit: (fileId: string, name: string) => void;
  onRenameFileCancel: () => void;
  innerSort: SortOption;
  search: string;
}

export default function PieceAssets({
  pieceId,
  onSelectAsset,
  onContextMenu,
  renamingFileId,
  onRenameFileSubmit,
  onRenameFileCancel,
  innerSort,
  search,
}: PieceAssetsProps) {
  const { data: files = [], isLoading: filesLoading } = useFiles(pieceId);
  const { data: folders = [], isLoading: foldersLoading } =
    useAssetFolderList(pieceId);

  const loading = filesLoading || foldersLoading;
  // Defer the skeleton: only reveal it if loading outlasts 300ms. Fast loads
  // resolve first and render content directly — no skeleton flash.
  const showSkeleton = useDelayedFlag(loading, 300);

  if (loading) {
    if (!showSkeleton) return null;
    return (
      <div className="space-y-1 py-1 pl-6 pr-2">
        <Skeleton className="h-5 w-full rounded" />
        <Skeleton className="h-5 w-3/4 rounded" />
      </div>
    );
  }

  return (
    <AssetFolderTree
      scope={pieceId}
      folders={folders}
      files={files}
      onSelectAsset={onSelectAsset}
      onFileContextMenu={(e, file) =>
        onContextMenu(e, "asset", pieceId, file.id, file.name || file.filename)
      }
      renamingFileId={renamingFileId}
      onRenameFileSubmit={onRenameFileSubmit}
      onRenameFileCancel={onRenameFileCancel}
      innerSort={innerSort}
      search={search}
    />
  );
}
