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
  location: (fileId: string) => ["files", "location", fileId] as const,
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

export interface FileLocation {
  path: string;
  exists: boolean;
}

/**
 * Absolute on-disk path for a file, plus whether it's still there.
 * Returns `null` when the file row is gone (404).
 *
 * Keyed under the `["files", …]` prefix on purpose: the existing
 * `useDeleteFileById` / `useRenameFile` / `useAssignFile` invalidations of
 * `["files"]` already clear this entry, so no new invalidation wiring is
 * needed. (`useDeleteFile` invalidates the narrower `["files", pieceId]`,
 * which does not prefix-match this key, so it is NOT among these.)
 */
export function useFileLocation(fileId: string | null | undefined) {
  return useQuery({
    queryKey: fileKeys.location(fileId ?? ""),
    enabled: !!fileId,
    queryFn: async (): Promise<FileLocation | null> => {
      const res = await fetch(`/api/files/by-id/${fileId}/location`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch file location");
      return (await res.json()) as FileLocation;
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

/**
 * The server's own explanation of a failed upload, falling back to the status
 * code. Both upload routes answer `{ error }`; a bare "Upload failed" gave the
 * user — and the log — nothing to act on.
 */
async function uploadErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* not JSON (a 405 from a route mismatch, an HTML error page) */
  }
  return `Upload failed (${res.status})`;
}

/**
 * POST one file, to the piece when there is one and to the global store when
 * there isn't.
 *
 * The endpoint choice lives here, in ONE place, because it did not used to:
 * the piece-drop path in the editor hand-rolled its own `fetch` and drifted —
 * it never checked `res.ok` and never sent the probed dimensions.
 */
export async function uploadFileTo(pieceId: string | null, file: File): Promise<FileRecord> {
  const media = await probeMediaMetadata(file);

  const formData = new FormData();
  formData.append("file", file);
  if (media.duration != null) formData.append("mediaDuration", String(media.duration));
  if (media.width != null) formData.append("mediaWidth", String(media.width));
  if (media.height != null) formData.append("mediaHeight", String(media.height));

  const res = await fetch(pieceId ? `/api/pieces/${pieceId}/upload` : "/api/upload", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(await uploadErrorMessage(res));

  const data = await res.json();
  return data.file;
}

/**
 * Upload files against a piece — or globally when `pieceId` is null or empty.
 *
 * The empty string is treated as "no piece" deliberately, not defensively. The
 * chat panel is handed `activePieceId ?? ""`, and an empty id built the URL
 * `/api/pieces//upload`, which redirects to `/api/pieces/upload` and matches
 * `[pieceId]/route.ts` with `pieceId="upload"` — a route with no POST. Every
 * chat attachment sent with no piece open died on that 405.
 *
 * Uploading it as an unassigned asset is the right answer rather than blocking
 * the attach button: "here is an image, build something from it" is the reason
 * to attach before a piece exists.
 */
export function useFileUpload(pieceId: string | null) {
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  const upload = useCallback(
    async (file: File): Promise<FileRecord> => {
      setIsUploading(true);
      try {
        const record = await uploadFileTo(pieceId, file);
        // Same falsiness rule as the endpoint choice, and for the same reason:
        // an empty id here would invalidate ["files", ""], which matches no
        // query, so the upload would not show up in Resources until something
        // else forced a refetch.
        queryClient.invalidateQueries({
          queryKey: pieceId ? fileKeys.forPiece(pieceId) : fileKeys.global(),
        });
        return record;
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

/** Upload to the global (unassigned) store. */
export function useGlobalUpload() {
  return useFileUpload(null);
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
