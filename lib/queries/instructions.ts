import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface InstructionsDoc {
  source: "bundled" | "override";
  content: string;
  bundledUpdatedSinceFork: boolean | "unknown";
}

export const instructionKeys = {
  doc: ["instructions", "doc"] as const,
  memories: ["instructions", "memories"] as const,
};

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export function useInstructionsDoc() {
  return useQuery<InstructionsDoc>({
    queryKey: instructionKeys.doc,
    queryFn: async () => jsonOrThrow(await fetch("/api/instructions")),
  });
}

export function useMemories() {
  return useQuery<{ content: string }>({
    queryKey: instructionKeys.memories,
    queryFn: async () => jsonOrThrow(await fetch("/api/settings/memories")),
  });
}

export interface SaveResult {
  ok: true;
  sessionsTerminated: number;
}

export function useUpdateMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string): Promise<SaveResult> =>
      jsonOrThrow(
        await fetch("/api/settings/memories", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: instructionKeys.memories }),
  });
}

export function useSaveInstructionsOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string): Promise<SaveResult> =>
      jsonOrThrow(
        await fetch("/api/instructions/override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: instructionKeys.doc }),
  });
}

export function useRevertInstructionsOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SaveResult> =>
      jsonOrThrow(await fetch("/api/instructions/override", { method: "DELETE" })),
    onSuccess: () => qc.invalidateQueries({ queryKey: instructionKeys.doc }),
  });
}
