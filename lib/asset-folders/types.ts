import type { AssetFolderRecord, FileRecord } from "@/lib/db/schema/types";

export type { AssetFolderRecord };

/** Scope discriminator: a piece id, or null for the global file pool. */
export type AssetScope = string | null;

/** One level of the explorer: folders + assets directly inside `folderId`. */
export interface AssetTreeLevel {
  folders: AssetFolderRecord[];
  assets: FileRecord[];
}
