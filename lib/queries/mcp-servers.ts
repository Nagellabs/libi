import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { McpServerRecord } from "@/lib/db/schema/types";
import type { DependencyStatus } from "@/mcp/registry/types";

/**
 * UI-facing shape returned by GET /api/settings/mcp-servers.
 * `serverLastChecked` is converted to unix seconds (number) by the API;
 * the three server-status fields are always present (never undefined).
 */
export type McpServerUI = Omit<McpServerRecord, "serverLastChecked" | "envVars" | "headers"> & {
  serverStatus: "unknown" | "starting" | "up" | "down";
  serverError: string | null;
  serverLastChecked: number | null;
  /** RC-F: the raw `envVars` values are NEVER sent to the client. The API
   * exposes only the NAMES of configured env vars here; a value for a key
   * exists on the server but is redacted on read. */
  configuredEnvVars: string[];
  /** RC-F: the raw `headers` values (bearer-token secrets) are NEVER sent to
   * the client. The API exposes only the NAMES of configured headers here; the
   * value exists on the server but is redacted on read. */
  configuredHeaders: string[];
  /** True for bundled MCPs that have no spawnable server (whisper, local-tts,
   * local-music — libraries libi calls via `uv run`). UI uses this to hide
   * the meaningless "Server: …" line for those rows. */
  noServer: boolean;
};

export const mcpServerKeys = {
  all: ["mcp-servers"] as const,
};

export function useMcpServers() {
  return useQuery({
    queryKey: mcpServerKeys.all,
    queryFn: async (): Promise<McpServerUI[]> => {
      const res = await fetch("/api/settings/mcp-servers");
      if (!res.ok) throw new Error("Failed to fetch MCP servers");
      const data = await res.json();
      return data.servers;
    },
  });
}

export function useCreateMcpServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: {
        name: string;
        type: "stdio" | "http";
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        envVars?: Record<string, string>;
        requireApproval?: boolean;
      }
    ): Promise<McpServerRecord> => {
      const res = await fetch("/api/settings/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create MCP server");
      const data = await res.json();
      return data.server;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    },
  });
}

export function useUpdateMcpServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: { id: string } & Partial<{
      name: string;
      type: "stdio" | "http";
      command: string;
      args: string[];
      url: string;
      headers: Record<string, string>;
      envVars: Record<string, string>;
      enabled: boolean;
      requireApproval: boolean;
    }>): Promise<McpServerRecord> => {
      const res = await fetch(`/api/settings/mcp-servers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to update MCP server");
      const data = await res.json();
      return data.server;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/settings/mcp-servers/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete MCP server");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    },
  });
}

export function useResyncMcpServers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch("/api/settings/mcp-servers/resync", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to resync MCP servers");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    },
  });
}

export function useRetryMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/settings/mcp-servers/${id}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpServerKeys.all }),
  });
}

/* ------------------------------------------------------------------------- */
/* Per-binary dependency status                                              */
/* ------------------------------------------------------------------------- */

export type { DepRuntimeStatus, DependencyStatus } from "@/mcp/registry/types";

export function useMcpServerDependencies(id: string) {
  return useQuery({
    queryKey: ["mcp-server-dependencies", id],
    queryFn: async (): Promise<DependencyStatus[]> => {
      const res = await fetch(`/api/settings/mcp-servers/${id}/dependencies`);
      if (!res.ok) throw new Error(`Failed to load dependencies: ${res.status}`);
      const body = (await res.json()) as { dependencies: DependencyStatus[] };
      return body.dependencies;
    },
    refetchInterval: (query) => {
      // Short-poll while any dep is mid-flight (pending/installing). Stops
      // automatically once everything settles to installed/failed.
      const data = query.state.data;
      if (!data) return false;
      const anyInFlight = data.some((d) =>
        d.runtimeStatus === "installing" || d.runtimeStatus === "pending",
      );
      if (anyInFlight) return 2000;
      // Fallback: keep polling at 3s while anything is uninstalled (covers
      // legacy rows that don't have runtimeStatus populated yet).
      const anyMissing = data.some((d) => !d.installed);
      return anyMissing ? 3000 : false;
    },
  });
}

export function useRetryDependency(mcpId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (binary: string): Promise<void> => {
      const res = await fetch(`/api/settings/mcp-servers/${mcpId}/retry-dep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ binary }),
      });
      if (!res.ok) throw new Error("Retry failed");
    },
    onSuccess: () => {
      // Bump the cache so the user sees "installing" immediately and the
      // 2s poll kicks in.
      queryClient.invalidateQueries({ queryKey: ["mcp-server-dependencies", mcpId] });
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.all });
    },
  });
}

/* ------------------------------------------------------------------------- */
/* Install plan                                                               */
/* ------------------------------------------------------------------------- */

export interface McpInstallPlan {
  mcpId: string;
  name: string;
  plan: string;
  planPath: string;
}

/**
 * Fetches the markdown install plan for a bundled MCP.
 *
 * `enabled` defaults to `false` — flip it to `true` only when the user
 * expands the plan section (avoids fetching for cards the user never opens).
 */
export function useMcpInstallPlan(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["mcp-install-plan", id],
    enabled: options?.enabled ?? false,
    queryFn: async (): Promise<McpInstallPlan> => {
      const res = await fetch(`/api/settings/mcp-servers/${id}/install-plan`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ??
            `Failed to fetch install plan (${res.status})`,
        );
      }
      return res.json() as Promise<McpInstallPlan>;
    },
  });
}
