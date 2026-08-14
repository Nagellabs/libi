import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState, useCallback } from "react";
import type { FileRecord } from "@/lib/db/schema/types";
import { probeMediaMetadata } from "@/lib/utils/media-probe";

export const fileKeys = {
  forPiece: (pieceId: string) => ["files", pieceId] as const,
  global: () => ["files", "global"] as const,
  byId: (fileId: string) => ["files", "by-id", fileId] as const,
};

/**
 * Look up a single file by id. Returns `null` if the file doesn't exist
 * (deleted, never persisted, etc.) — used by the chat attachment chip
 * which falls back to a plain "filename + size" badge in that case.
 *
 * Cached separately from the per-piece file list so chat thumbnails
 * don't refetch on every piece switch. The piece-list invalidation in
 * `useDeleteFile`/`useDeleteFileById`/`useRenameFile` clears `["files"]`
 * which covers this entry too.
 */
export function useFileById(fileId: string | null | undefined) {
  return useQuery({
    queryKey: fileKeys.byId(fileId ?? ""),
    enabled: !!fileId,
    queryFn: async (): Promise<FileRecord | null> => {
      const res = await fetch(`/api/files/by-id/${fileId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch file");
      const data = await res.json();
      return data.file;
    },
  });
}

export function useFiles(pieceId: string) {
  return useQuery({
    queryKey: fileKeys.forPiece(pieceId),
    queryFn: async (): Promise<FileRecord[]> => {
      const res = await fetch(`/api/pieces/${pieceId}/files`);
      if (!res.ok) throw new Error("Failed to fetch files");
      const data = await res.json();
      return data.files;
    },
    enabled: !!pieceId,
  });
}

export function useDeleteFile(pieceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileId: string): Promise<void> => {
      const res = await fetch(`/api/pieces/${pieceId}/files/${fileId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete file");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.forPiece(pieceId) });
    },
  });
}

export function useDeleteFileById() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileId: string): Promise<void> => {
      const res = await fetch(`/api/files/by-id/${fileId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete file");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useRenameFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fileId, name }: { fileId: string; name: string }): Promise<void> => {
      const res = await fetch(`/api/files/by-id/${fileId}/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to rename file");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useUpdateFileNotes() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      fileId,
      notes,
      mode,
    }: {
      fileId: string;
      notes: string;
      mode?: "append" | "replace";
    }): Promise<void> => {
      const res = await fetch(`/api/files/by-id/${fileId}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes, mode }),
      });
      if (!res.ok) throw new Error("Failed to update file notes");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useFileUpload(pieceId: string) {
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  const upload = useCallback(
    async (file: File): Promise<FileRecord> => {
      setIsUploading(true);
      try {
        const media = await probeMediaMetadata(file);

        const formData = new FormData();
        formData.append("file", file);
        if (media.duration != null) formData.append("mediaDuration", String(media.duration));
        if (media.width != null) formData.append("mediaWidth", String(media.width));
        if (media.height != null) formData.append("mediaHeight", String(media.height));

        const res = await fetch(`/api/pieces/${pieceId}/upload`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error("Upload failed");

        const data = await res.json();
        queryClient.invalidateQueries({ queryKey: fileKeys.forPiece(pieceId) });
        return data.file;
      } finally {
        setIsUploading(false);
      }
    },
    [pieceId, queryClient],
  );

  return { upload, isUploading };
}

export function useGlobalFiles() {
  return useQuery({
    queryKey: fileKeys.global(),
    queryFn: async (): Promise<FileRecord[]> => {
      const res = await fetch("/api/files");
      if (!res.ok) throw new Error("Failed to fetch global files");
      const data = await res.json();
      return data.files;
    },
  });
}

export function useGlobalUpload() {
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  const upload = useCallback(
    async (file: File): Promise<FileRecord> => {
      setIsUploading(true);
      try {
        const media = await probeMediaMetadata(file);

        const formData = new FormData();
        formData.append("file", file);
        if (media.duration != null) formData.append("mediaDuration", String(media.duration));
        if (media.width != null) formData.append("mediaWidth", String(media.width));
        if (media.height != null) formData.append("mediaHeight", String(media.height));

        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error("Upload failed");

        const data = await res.json();
        queryClient.invalidateQueries({ queryKey: fileKeys.global() });
        return data.file;
      } finally {
        setIsUploading(false);
      }
    },
    [queryClient],
  );

  return { upload, isUploading };
}

export function useAssignFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fileId, pieceId }: { fileId: string; pieceId: string | null }): Promise<void> => {
      const res = await fetch(`/api/files/by-id/${fileId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pieceId }),
      });
      if (!res.ok) throw new Error("Failed to assign file");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}
