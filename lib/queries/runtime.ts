import { useQuery } from "@tanstack/react-query";

export interface RuntimeInfo {
  /** When libi was launched from a worktree checkout, the worktree's basename.
   *  Null in canonical / non-worktree runs. The sidebar badges the brand
   *  with this string so it's obvious which checkout the UI belongs to. */
  worktreeName: string | null;
}

const RUNTIME_QUERY_KEY = ["runtime"] as const;

async function fetchRuntime(): Promise<RuntimeInfo> {
  const res = await fetch("/api/runtime");
  if (!res.ok) throw new Error(`runtime fetch failed (${res.status})`);
  return res.json();
}

/** Cached for the lifetime of the page — worktree name doesn't change at runtime. */
export function useRuntimeInfo() {
  return useQuery({
    queryKey: RUNTIME_QUERY_KEY,
    queryFn: fetchRuntime,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
}
