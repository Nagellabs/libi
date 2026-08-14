"use client";

import { useQuery } from "@tanstack/react-query";
import type { PlanUsageWindows } from "@/lib/claude/plan-usage";

export type PlanUsageResponse =
  | { available: true; windows: PlanUsageWindows }
  | { available: false; reason: "no_token" | "error" };

export const planUsageKeys = {
  all: ["claude-plan-usage"] as const,
};

/**
 * Claude subscription plan usage for the budget popover. Enabled only while
 * the popover is open for a Claude Code session — no background polling.
 * Server caches for 60s; mirror that here.
 */
export function usePlanUsage(enabled: boolean) {
  return useQuery({
    queryKey: planUsageKeys.all,
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<PlanUsageResponse> => {
      const res = await fetch("/api/claude/plan-usage");
      if (!res.ok) return { available: false, reason: "error" };
      return (await res.json()) as PlanUsageResponse;
    },
  });
}
