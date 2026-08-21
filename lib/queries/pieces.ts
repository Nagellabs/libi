import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CompositionManifest } from "@/lib/composition/persistence";

export interface PieceSummary {
  id: string;
  name: string;
  description?: string;
  nameSetByUser: boolean;
  hasDraft: boolean | null;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO string, or null when nobody has ever opened this piece. */
  lastOpenedAt: string | null;
}

interface AudioClipData {
  id: string;
  kind: "inline" | "standalone";
  fileId: string;
  startTime: number;
  duration: number;
  trimStart: number;
  volume: number;
  enabled: boolean;
  linkedSceneId?: string;
  label?: string;
}

// ── Query keys ──────────────────────────────────────────────────────

export const pieceKeys = {
  all: ["pieces"] as const,
  detail: (id: string) => ["pieces", id] as const,
  composition: (id: string) => ["pieces", id, "composition"] as const,
};

// ── Queries ─────────────────────────────────────────────────────────

export function usePieces() {
  return useQuery({
    queryKey: pieceKeys.all,
    queryFn: async (): Promise<PieceSummary[]> => {
      const res = await fetch("/api/pieces");
      if (!res.ok) throw new Error("Failed to fetch pieces");
      return res.json();
    },
  });
}

export function usePiece(pieceId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: pieceKeys.detail(pieceId),
    queryFn: async (): Promise<PieceSummary> => {
      const res = await fetch(`/api/pieces/${pieceId}`);
      if (!res.ok) throw new Error("Piece not found");
      return res.json();
    },
    retry: false,
    enabled: options?.enabled,
  });
}

export function usePieceComposition(pieceId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: pieceKeys.composition(pieceId),
    queryFn: async (): Promise<{
      manifest: CompositionManifest;
      audioClips: AudioClipData[];
    }> => {
      const res = await fetch(`/api/pieces/${pieceId}/composition`);
      if (!res.ok) {
        return {
          manifest: { width: 1920, height: 1080, fps: 30 },
          audioClips: [],
        };
      }
      return res.json();
    },
    enabled: options?.enabled,
  });
}

// ── Mutations ───────────────────────────────────────────────────────

export function useCreatePiece() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async (): Promise<PieceSummary> => {
      const res = await fetch("/api/pieces", { method: "POST" });
      if (!res.ok) {
        // Carry the server's own words when it sent any — "Failed to create
        // piece" on its own tells the user nothing they can act on.
        const detail = await res.text().catch(() => "");
        throw new Error(
          detail.trim() ? `Couldn't create a piece: ${detail.slice(0, 200)}` : "Couldn't create a piece.",
        );
      }
      return res.json();
    },
    onSuccess: (piece) => {
      queryClient.invalidateQueries({ queryKey: pieceKeys.all });
      router.push("/editor");
    },
    // Without this the rejection lands in `mutation.error` and nobody reads it,
    // so a failing POST /api/pieces makes every "New piece" / "Create your
    // first piece" button look simply inert — clicked, nothing happened, no
    // reason given. Reported exactly that way from dev Electron.
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Couldn't create a piece.");
    },
  });
}

export function useDeletePiece() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async (pieceId: string): Promise<void> => {
      const res = await fetch(`/api/pieces/${pieceId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete piece");
    },
    onSuccess: (_data, pieceId) => {
      queryClient.invalidateQueries({ queryKey: pieceKeys.all });
      queryClient.removeQueries({ queryKey: pieceKeys.detail(pieceId) });
      // Navigate away if we deleted the currently open piece
      if (window.location.pathname.includes(pieceId)) {
        router.push("/editor");
      }
    },
  });
}

export function useUpdatePieceName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ pieceId, name }: { pieceId: string; name: string }): Promise<PieceSummary> => {
      const res = await fetch(`/api/pieces/${pieceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to update piece name");
      return res.json();
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: pieceKeys.detail(updated.id) });
      queryClient.invalidateQueries({ queryKey: pieceKeys.all });
    },
  });
}
