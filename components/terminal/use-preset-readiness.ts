"use client";

import { useCallback } from "react";
import { useAllAgentStatus } from "@/lib/queries/agent-status";
import { isSetupAgentId } from "@/lib/agents/setup/registry";

/**
 * Whether a terminal CLI preset's agent is ready to launch, by
 * `/api/agents/status`. One rule for everything that decides what a NEW
 * terminal runs — the "Launch CLI" dropdown and both "New terminal" buttons
 * (sidebar "+" and the terminal panel):
 *
 * - a preset with no setup agent (the plain Shell) is never gated;
 * - while the status is still loading nothing is gated — never a flash of
 *   "not ready" for an agent that is;
 * - an agent missing from the status response counts as not ready.
 *
 * `enabled: false` skips the fetch for a caller that only needs it on the
 * Terminal surface; with no data, nothing is gated.
 */
export function usePresetReadiness(opts: { enabled?: boolean } = {}): {
  isNotReady: (presetId: string) => boolean;
} {
  const { data: statuses } = useAllAgentStatus({ enabled: opts.enabled ?? true });
  const isNotReady = useCallback(
    (presetId: string): boolean =>
      statuses !== undefined &&
      isSetupAgentId(presetId) &&
      statuses[presetId]?.ready !== true,
    [statuses],
  );
  return { isNotReady };
}
