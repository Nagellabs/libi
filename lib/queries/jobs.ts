"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobStatusSnapshot } from "@/lib/jobs/types";

export const jobKeys = {
  all: ["jobs"] as const,
  list: (filter?: { kind?: string; status?: string }) =>
    [...jobKeys.all, "list", filter ?? {}] as const,
};

export function useAllJobs(opts?: { kind?: string; status?: string }) {
  return useQuery({
    queryKey: jobKeys.list(opts),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.kind) params.set("kind", opts.kind);
      if (opts?.status) params.set("status", opts.status);
      const res = await fetch(`/api/jobs?${params.toString()}`);
      if (!res.ok) throw new Error("failed to load jobs");
      return (await res.json()) as { jobs: JobStatusSnapshot[] };
    },
    refetchInterval: (query) => {
      const data = query.state.data as { jobs?: JobStatusSnapshot[] } | undefined;
      const anyInflight = data?.jobs?.some(
        (j) =>
          j.status === "running" ||
          j.status === "queued" ||
          j.status === "cancel-requested",
      );
      return anyInflight ? 2000 : false;
    },
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("cancel failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: jobKeys.all }),
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("retry failed");
      return (await res.json()) as { jobId: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: jobKeys.all }),
  });
}
