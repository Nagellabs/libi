import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ModelState } from "@/lib/sessions/model-option";

export type SessionModelResponse =
  | ({ supported: true } & ModelState)
  | { supported: false };

export const sessionModelKeys = {
  detail: (sessionId: string) => ["session-model", sessionId] as const,
};

export function useSessionModel(sessionId: string | null) {
  return useQuery({
    queryKey: sessionModelKeys.detail(sessionId ?? "none"),
    enabled: !!sessionId,
    queryFn: async (): Promise<SessionModelResponse> => {
      const res = await fetch(`/api/sessions/${sessionId}/model`);
      if (!res.ok) throw new Error("Failed to fetch session model");
      return (await res.json()) as SessionModelResponse;
    },
  });
}

export function useSetSessionModel(sessionId: string | null) {
  const queryClient = useQueryClient();
  const key = sessionModelKeys.detail(sessionId ?? "none");

  return useMutation({
    mutationFn: async (vars: { modelId: string }): Promise<void> => {
      const res = await fetch(`/api/sessions/${sessionId}/model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to set model");
      }
    },
    // Optimistic: the pill swaps to the new model immediately.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<SessionModelResponse>(key);
      queryClient.setQueryData<SessionModelResponse>(key, (old) =>
        old && old.supported
          ? { ...old, currentModelId: vars.modelId }
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
