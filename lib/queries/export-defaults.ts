"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GraphicsQuality } from "@/lib/engine/types";

export interface ExportDefaultsValue {
  format: "mp4" | "webm";
  quality: "source" | "1080p" | "1440p" | "4k";
  graphicsQuality: GraphicsQuality;
}

export const exportDefaultsKeys = {
  all: ["export-defaults"] as const,
};

export function useExportDefaults() {
  return useQuery({
    queryKey: exportDefaultsKeys.all,
    queryFn: async (): Promise<ExportDefaultsValue> => {
      const res = await fetch("/api/settings/export");
      if (!res.ok) throw new Error("Failed to load export defaults");
      return (await res.json()) as ExportDefaultsValue;
    },
    staleTime: 30_000,
  });
}

export function useUpdateExportDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      partial: Pick<ExportDefaultsValue, "format" | "quality"> &
        Partial<Pick<ExportDefaultsValue, "graphicsQuality">>,
    ): Promise<ExportDefaultsValue> => {
      const res = await fetch("/api/settings/export", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      if (!res.ok) throw new Error("Failed to update export defaults");
      return (await res.json()) as ExportDefaultsValue;
    },
    onSuccess: (v) => {
      qc.setQueryData(exportDefaultsKeys.all, v);
    },
  });
}
