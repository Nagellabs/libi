"use client";

import { useQuery } from "@tanstack/react-query";
import type { CaptionStyle } from "@/lib/captions/types";

/** React Query key for the caption-style list (invalidated by the
 *  `caption-styles` refresh_query event after the agent creates/deletes one). */
export const captionStyleKeys = {
  all: ["caption-styles"] as const,
};

/**
 * List all caption styles (bundled curated looks + user-created ones) for the
 * Style-tab picker. Falls back to nothing while loading — callers default to the
 * bundled `CAPTION_STYLES` const so the grid always renders.
 */
export function useCaptionStyles() {
  return useQuery({
    queryKey: captionStyleKeys.all,
    queryFn: async (): Promise<CaptionStyle[]> => {
      const res = await fetch("/api/caption-styles");
      if (!res.ok) throw new Error(`list caption styles failed (${res.status})`);
      const data = (await res.json()) as { styles: CaptionStyle[] };
      return data.styles;
    },
  });
}
