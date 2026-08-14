import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TerminalSessionMeta } from "@/lib/terminal/types";

// ── Query keys ──────────────────────────────────────────────────────

export const terminalKeys = {
  all: ["terminal-sessions"] as const,
};

// ── Queries ─────────────────────────────────────────────────────────

/**
 * Live terminal sessions (newest first). Server-side changes (exit,
 * rename, create from elsewhere) arrive via the `refresh_query` SSE
 * event with queryKey "terminal-sessions" → dispatch-refresh-query
 * invalidates this cache.
 */
export function useTerminalSessions(enabled = true) {
  return useQuery({
    queryKey: terminalKeys.all,
    queryFn: async (): Promise<TerminalSessionMeta[]> => {
      const res = await fetch("/api/terminal/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: TerminalSessionMeta[] };
      return data.sessions;
    },
    enabled,
  });
}

// ── Mutations ───────────────────────────────────────────────────────

export function useCreateTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    // Accepts either a bare cliId (the common case) or `{ cliId, initialInput }`
    // when the caller wants a command waiting at the prompt — see the sign-in
    // remedies in lib/agents/terminal-remedy.ts. `initialInput` is typed but
    // NOT run.
    mutationFn: async (
      arg: string | { cliId: string; initialInput?: string },
    ): Promise<TerminalSessionMeta> => {
      const payload = typeof arg === "string" ? { cliId: arg } : arg;
      const res = await fetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: terminalKeys.all });
    },
  });
}

export function useRenameTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const res = await fetch(`/api/terminal/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: terminalKeys.all });
    },
  });
}

export function useCloseTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/terminal/sessions/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: terminalKeys.all });
    },
  });
}
