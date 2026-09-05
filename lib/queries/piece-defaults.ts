"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export interface PieceDefaultsValue {
  aspectRatioId: string;
}

export const pieceDefaultsKeys = {
  all: ["piece-defaults"] as const,
};

export function usePieceDefaults() {
  return useQuery({
    queryKey: pieceDefaultsKeys.all,
    queryFn: async (): Promise<PieceDefaultsValue> => {
      const res = await fetch("/api/settings/piece-defaults");
      if (!res.ok) throw new Error("Failed to load piece defaults");
      return (await res.json()) as PieceDefaultsValue;
    },
    staleTime: 30_000,
  });
}

export function useUpdatePieceDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (partial: PieceDefaultsValue): Promise<PieceDefaultsValue> => {
      const res = await fetch("/api/settings/piece-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      if (!res.ok) throw new Error("Failed to update piece defaults");
      return (await res.json()) as PieceDefaultsValue;
    },
    onSuccess: (v) => {
      qc.setQueryData(pieceDefaultsKeys.all, v);
    },
    // A failed PUT previously did nothing visible — the button just stayed
    // unselected with no explanation. Surface it like the rest of the
    // mutation hooks in this directory (e.g. lib/queries/audio-clips.ts).
    onError: () => toast.error("Couldn't update the default aspect ratio"),
  });
}
