import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssetFolderRecord, FileRecord } from "@/lib/db/schema/types";

export type AssetScope = string | null;
type Level = {
  folders: (AssetFolderRecord & { assetCount: number })[];
  assets: FileRecord[];
};

export const assetFolderKeys = {
  level: (scope: AssetScope, folderId: string | null) =>
    ["asset-folders", scope ?? "global", folderId ?? "root"] as const,
  scope: (scope: AssetScope) => ["asset-folders", scope ?? "global"] as const,
};

function levelUrl(scope: AssetScope, folderId: string | null): string {
  const qs = folderId ? `?folderId=${folderId}` : "";
  return scope === null
    ? `/api/asset-folders${qs}`
    : `/api/pieces/${scope}/asset-folders${qs}`;
}

export function useAssetLevel(scope: AssetScope, folderId: string | null) {
  return useQuery({
    queryKey: assetFolderKeys.level(scope, folderId),
    queryFn: async (): Promise<Level> => {
      const res = await fetch(levelUrl(scope, folderId));
      if (!res.ok) throw new Error("failed to load asset level");
      return res.json();
    },
  });
}

export function useAssetFolderList(scope: AssetScope, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["asset-folders", scope ?? "global", "all"],
    enabled: options?.enabled ?? true,
    queryFn: async (): Promise<(AssetFolderRecord & { assetCount: number })[]> => {
      const url =
        (scope === null ? `/api/asset-folders` : `/api/pieces/${scope}/asset-folders`) + `?tree=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("failed to load asset folder list");
      return (await res.json()).folders;
    },
  });
}

function useScopeInvalidator(scope: AssetScope) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: assetFolderKeys.scope(scope) });
    qc.invalidateQueries({ queryKey: ["files"] });
  };
}

export function useCreateAssetFolder(scope: AssetScope) {
  const invalidate = useScopeInvalidator(scope);
  return useMutation({
    mutationFn: async (input: { name: string; parentFolderId?: string | null }) => {
      const res = await fetch(`/api/asset-folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pieceId: scope,
          name: input.name,
          parentFolderId: input.parentFolderId ?? undefined,
        }),
      });
      if (!res.ok) throw new Error("create failed");
      return res.json();
    },
    onSuccess: invalidate,
  });
}

export function useRenameAssetFolder(scope: AssetScope) {
  const invalidate = useScopeInvalidator(scope);
  return useMutation({
    mutationFn: async (input: { folderId: string; name: string }) => {
      const res = await fetch(`/api/asset-folders/${input.folderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: input.name }),
      });
      if (!res.ok) throw new Error("rename failed");
      return res.json();
    },
    onSuccess: invalidate,
  });
}

export function useMoveAssetFolder(scope: AssetScope) {
  const invalidate = useScopeInvalidator(scope);
  return useMutation({
    mutationFn: async (input: { folderId: string; parentFolderId: string | null }) => {
      const res = await fetch(`/api/asset-folders/${input.folderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentFolderId: input.parentFolderId }),
      });
      if (!res.ok) throw new Error("move failed");
      return res.json();
    },
    onSuccess: invalidate,
  });
}

export function useDeleteAssetFolder(scope: AssetScope) {
  const invalidate = useScopeInvalidator(scope);
  return useMutation({
    mutationFn: async (input: {
      folderId: string;
      mode?: "orphan" | "cascade";
      confirm?: boolean;
    }) => {
      const qs = new URLSearchParams();
      if (input.mode) qs.set("mode", input.mode);
      if (input.confirm) qs.set("confirm", "true");
      const res = await fetch(`/api/asset-folders/${input.folderId}?${qs}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("delete failed");
      return res.json();
    },
    onSuccess: invalidate,
  });
}

export function useMoveAsset(scope: AssetScope) {
  const invalidate = useScopeInvalidator(scope);
  return useMutation({
    mutationFn: async (input: { fileId: string; folderId: string | null }) => {
      const res = await fetch(`/api/files/by-id/${input.fileId}/folder`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId: input.folderId }),
      });
      if (!res.ok) throw new Error("move asset failed");
      return res.json();
    },
    onSuccess: invalidate,
  });
}
