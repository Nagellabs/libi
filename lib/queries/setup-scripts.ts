import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export const setupScriptKeys = {
  dir: ["setup-scripts", "dir"] as const,
};

/**
 * Thrown for anything OTHER than the route's own not-found answer (a 500 with
 * `{ error }` when the install is missing a script): a network error, an
 * unexpected status, or a body that isn't that shape. The Providers tab reads
 * this to tell "can't reach the route" apart from "the route answered: your
 * install is missing scripts."
 */
export class SetupScriptsUnreachableError extends Error {}

/**
 * The absolute folder of libi's provider setup scripts on the machine that runs
 * the setup terminal (`GET /api/agents/setup-scripts`). Every provider command
 * names a script by that path, so the Providers tab disables its actions while
 * `.data` is `undefined`, as it does for the shell flavor.
 */
export function useSetupScriptsDir(): UseQueryResult<string> {
  return useQuery({
    queryKey: setupScriptKeys.dir,
    queryFn: async () => {
      let res: Response;
      try {
        res = await fetch("/api/agents/setup-scripts");
      } catch (err) {
        throw new SetupScriptsUnreachableError(
          `setup scripts folder fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // The route's own not-found answer: the install is missing a script.
        if (typeof body?.error === "string") throw new Error(body.error);
        throw new SetupScriptsUnreachableError(`setup scripts folder fetch failed (${res.status})`);
      }
      return ((await res.json()) as { dir: string }).dir;
    },
    staleTime: Infinity,
  });
}
