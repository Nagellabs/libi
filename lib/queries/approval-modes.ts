import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { ApprovalMode } from "@/lib/approval/mode";

// ── Query keys ──────────────────────────────────────────────────────

export const approvalModeKeys = {
  all: ["approval-modes"] as const,
};

// ── Queries ─────────────────────────────────────────────────────────

export function useApprovalModes() {
  return useQuery({
    queryKey: approvalModeKeys.all,
    queryFn: async (): Promise<Record<string, ApprovalMode>> => {
      const res = await fetch("/api/sessions/permission-modes");
      if (!res.ok) throw new Error("Failed to fetch approval modes");
      const data = (await res.json()) as { modes: Record<string, ApprovalMode> };
      return data.modes;
    },
  });
}

// ── Mutations ───────────────────────────────────────────────────────

export function useUpdateApprovalMode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: {
      agentId: string;
      mode: ApprovalMode;
    }): Promise<void> => {
      const res = await fetch("/api/sessions/permission-modes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to update approval mode");
      }
    },
    // Optimistic write — the icon swaps immediately on click; we roll back
    // on error and refetch on settle to converge with server state.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: approvalModeKeys.all });
      const prev = queryClient.getQueryData<Record<string, ApprovalMode>>(
        approvalModeKeys.all,
      );
      queryClient.setQueryData<Record<string, ApprovalMode>>(
        approvalModeKeys.all,
        (old) => ({
          ...(old ?? {}),
          [vars.agentId]: vars.mode,
        }),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData(approvalModeKeys.all, ctx.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: approvalModeKeys.all });
    },
  });
}
