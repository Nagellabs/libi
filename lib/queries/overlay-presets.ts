"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "@/lib/queries/pieces";
import { trackEvent } from "@/lib/analytics/client";

/** A bundled or user-saved overlay preset (shape mirrors the tool layer). */
export interface OverlayPreset {
  id: string;
  name: string;
  kind: string;
  source: "bundled" | "user";
  fields: Record<string, unknown>;
  /** ISO creation time (user presets only). */
  createdAt?: string;
  /** ISO last-save time (user presets only); drives the dialog's sort. */
  updatedAt?: string;
}

/** List bundled + user presets, optionally filtered by overlay kind. */
export function useOverlayPresets(kind?: string) {
  return useQuery({
    queryKey: ["overlay-presets", kind ?? "all"],
    queryFn: async (): Promise<OverlayPreset[]> => {
      const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
      const res = await fetch(`/api/overlay-presets${qs}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `list failed (${res.status})`);
      }
      const data = (await res.json()) as { presets: OverlayPreset[] };
      return data.presets;
    },
  });
}

/** Thrown by useSavePreset when the name is taken; carries the conflicting id. */
export class PresetNameConflictError extends Error {
  constructor(public presetId: string, public presetName: string) {
    super("preset_name_exists");
    this.name = "PresetNameConflictError";
  }
}

/** Capture an overlay's look as a named user preset. */
export function useSavePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      pieceId: string;
      overlayId: string;
      name: string;
      override?: boolean;
    }): Promise<{ presetId: string }> => {
      const res = await fetch("/api/overlay-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string; presetId?: string; name?: string;
        };
        if (res.status === 409 && body.error === "preset_name_exists") {
          throw new PresetNameConflictError(body.presetId ?? "", body.name ?? args.name);
        }
        throw new Error(body.error ?? `save failed (${res.status})`);
      }
      return (await res.json()) as { presetId: string };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["overlay-presets"] });
    },
  });
}

/** Apply a preset onto an overlay; invalidates the piece's composition. */
export function useApplyPreset(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      overlayId: string;
      presetId: string;
      kind: string;
    }): Promise<{ success: true }> => {
      const res = await fetch(
        `/api/pieces/${pieceId}/overlays/${encodeURIComponent(args.overlayId)}/apply-preset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ presetId: args.presetId }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `apply failed (${res.status})`);
      }
      return (await res.json()) as { success: true };
    },
    onSuccess: (_data, args) => {
      // kind is bounded-cardinality (text/image/video/code/three/tracked).
      trackEvent("preset_applied", { kind: args.kind });
      void qc.invalidateQueries({ queryKey: pieceKeys.composition(pieceId) });
    },
  });
}

/** Delete a user-saved preset. */
export function useDeletePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<{ success: true }> => {
      const res = await fetch(`/api/overlay-presets/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `delete failed (${res.status})`);
      }
      return (await res.json()) as { success: true };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["overlay-presets"] });
    },
  });
}
