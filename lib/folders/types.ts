import type { FolderRecord } from "@/lib/db/schema/types";

export type { FolderRecord };

/** A folder plus a precomputed count of pieces directly inside it. */
export interface FolderWithCount {
  id: string;
  name: string;
  parentFolderId: string | null;
  pieceCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type DeleteFolderMode = "orphan" | "cascade";
