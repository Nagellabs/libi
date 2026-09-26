"use client";

import { useQuery } from "@tanstack/react-query";
import type { CustomEffectManifest } from "@/lib/effects/package-types";

/** One custom effect as shipped by `GET /api/effects` — validated manifest, animate source and its sha256. */
export interface CustomEffectEntry {
  meta: CustomEffectManifest;
  source: string;
  sourceHash: string;
}

export interface CustomEffectsPayload {
  custom: CustomEffectEntry[];
}

export const effectsCatalogKeys = {
  custom: ["effects", "custom"] as const,
};

/**
 * Fetch the custom effect packages (manifest + animate source) from the server.
 * The page registers curve-backed defs from these — it never compiles or runs
 * the source, which only the effect sandbox samples — see
 * `useRegisterCustomEffects`. 5-minute staleTime: custom packages change rarely.
 */
export function useCustomEffects() {
  return useQuery<CustomEffectsPayload>({
    queryKey: effectsCatalogKeys.custom,
    queryFn: async () => {
      const res = await fetch("/api/effects");
      if (!res.ok) throw new Error(`failed to load custom effects (${res.status})`);
      return (await res.json()) as CustomEffectsPayload;
    },
    staleTime: 5 * 60 * 1000,
  });
}
