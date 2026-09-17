import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ShellFlavor } from "@/lib/terminal/shell-quote";

/**
 * The quoting flavor the PTY actually runs, decided server-side (see
 * `app/api/terminal/shell-flavor/route.ts`). A command built for the wrong
 * flavor would be typed into the wrong shell, so callers disable every command
 * button while `.data` is `undefined`.
 */
export function useShellFlavor(): UseQueryResult<ShellFlavor> {
  return useQuery({
    queryKey: ["shell-flavor"],
    queryFn: async () => {
      const res = await fetch("/api/terminal/shell-flavor");
      if (!res.ok) throw new Error(`shell flavor fetch failed (${res.status})`);
      return ((await res.json()) as { flavor: ShellFlavor }).flavor;
    },
    staleTime: Infinity,
  });
}
