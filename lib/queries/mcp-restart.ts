import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { mcpHealthKeys } from "@/lib/queries/mcp-health";

// ── Mutations ───────────────────────────────────────────────────────

/**
 * Restart libi's MCP endpoint process (`POST /api/mcp/restart`). Resolves with
 * the port it came back on — normally the same one; a different port means it
 * was taken while the endpoint was down.
 *
 * Health is invalidated on success AND failure: a failed restart can leave the
 * endpoint `gave-up`, which the card has to show.
 */
export function useRestartMcpEndpoint(): UseMutationResult<{ port: number }, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ port: number }> => {
      const res = await fetch("/api/mcp/restart", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { port?: unknown; error?: unknown };
      if (!res.ok || typeof body.port !== "number") {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to restart the libi MCP endpoint",
        );
      }
      return { port: body.port };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: mcpHealthKeys.all }),
  });
}
