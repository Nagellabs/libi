import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Storyboard } from "@/lib/storyboard/types";
import type { CostSummary } from "@/lib/storyboard/cost";
import type { CardPatch } from "@/lib/storyboard/repo";
import type { CacheLookup } from "@/lib/storyboard/model-schema-cache";
import type { GenParamValue } from "@/lib/storyboard/types";

export const storyboardKeys = {
  all: ["storyboard"] as const,
  detail: (pieceId: string) => ["storyboard", pieceId] as const,
};

export type SchemaEntry = { apiUrl: string; model: string; lookup: CacheLookup };
export type SchemasMap = Record<string, SchemaEntry>;
export type StoryboardResponse = {
  storyboard: Storyboard | null;
  schemas?: SchemasMap;
  sketchRevs?: Record<string, Record<string, string>>;
};
export type StoryboardData = {
  storyboard: Storyboard | null;
  schemas: SchemasMap;
  sketchRevs: Record<string, Record<string, string>>;
};

export function useStoryboard(pieceId: string | null) {
  return useQuery({
    queryKey: storyboardKeys.detail(pieceId ?? ""),
    enabled: !!pieceId,
    queryFn: async (): Promise<StoryboardData> => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as StoryboardResponse;
      return { storyboard: body.storyboard, schemas: body.schemas ?? {}, sketchRevs: body.sketchRevs ?? {} };
    },
  });
}

export function useUpdateCard(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, patch }: { cardId: string; patch: CardPatch }) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard/cards/${cardId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export function useUpdateLayout(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (layout: { positions: Record<string, { x: number; y: number }> }) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export function useSelectTake(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, takeId }: { cardId: string; takeId: string }) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard/cards/${cardId}/take`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ takeId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export function useHideTake(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, takeId }: { cardId: string; takeId: string }) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard/cards/${cardId}/take`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ takeId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export type UpdateGenParamVars = {
  cardId: string;
  tier: "keyframe" | "clip";
  paramKey: string;
  value: GenParamValue | null;
};

/** Set (or clear, with imageFileId:null) the imported image used AS a sketch slot. */
export function useSetSketchImage(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, slotId, imageFileId }: { cardId: string; slotId: string; imageFileId: string | null }) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard/cards/${cardId}/sketches/${slotId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageFileId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export function useUpdateGenParam(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, tier, paramKey, value }: UpdateGenParamVars) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard/cards/${cardId}/gen`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier, paramKey, value }),
      });
      if (!r.ok) {
        // Surface the validation issue to the caller (422 → { issues }).
        const body = await r.json().catch(() => ({}));
        throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { issues: body.issues });
      }
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export function useSetReference(pieceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, paramKey, fromCardId }: { cardId: string; paramKey: string; fromCardId: string | null }) => {
      const r = await fetch(`/api/pieces/${pieceId}/storyboard/cards/${cardId}/reference`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paramKey, fromCardId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: storyboardKeys.detail(pieceId) }),
  });
}

export type { CostSummary };
