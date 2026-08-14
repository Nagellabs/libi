import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "./pieces";

export interface FolderNode {
  id: string;
  name: string;
  parentFolderId: string | null;
  pieceCount: number;
  createdAt: string;
  updatedAt: string;
}

export const folderKeys = {
  all: ["folders"] as const,
};

export function useFolders() {
  return useQuery({
    queryKey: folderKeys.all,
    queryFn: async (): Promise<FolderNode[]> => {
      const res = await fetch("/api/folders");
      if (!res.ok) throw new Error("Failed to fetch folders");
      return (await res.json()).folders;
    },
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; parentFolderId?: string | null }) => {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to create folder");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: folderKeys.all }),
  });
}

export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ folderId, name }: { folderId: string; name: string }) => {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to rename folder");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: folderKeys.all }),
  });
}

export function useMoveFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folderId,
      parentFolderId,
    }: {
      folderId: string;
      parentFolderId: string | null;
    }) => {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentFolderId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to move folder");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: folderKeys.all }),
  });
}

export function useMovePieceToFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      pieceId,
      folderId,
    }: {
      pieceId: string;
      folderId: string | null;
    }) => {
      const res = await fetch(`/api/pieces/${pieceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error("Failed to move piece");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: folderKeys.all });
      qc.invalidateQueries({ queryKey: pieceKeys.all });
    },
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folderId,
      mode,
    }: {
      folderId: string;
      mode: "orphan" | "cascade";
    }) => {
      const res = await fetch(`/api/folders/${folderId}?mode=${mode}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete folder");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: folderKeys.all });
      qc.invalidateQueries({ queryKey: pieceKeys.all });
    },
  });
}
