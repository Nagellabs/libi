"use client";
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { SkillInstallErrorCode, SkillInstallView, SkillInstallsResponse } from "@/lib/agents/skill-installs-types";

// ── Query keys ──────────────────────────────────────────────────────

export const skillInstallKeys = { all: ["skill-installs"] as const };

export type AddSkillInstallRequest =
  | { agentId: SetupAgentId; scope: "user" }
  | { agentId: SetupAgentId; scope: "folder"; folderPath: string };

/** The route's `{ error: <code>, message }` as a thrown error; `request_failed` when the body had neither. */
export class SkillInstallRequestError extends Error {
  constructor(
    readonly code: SkillInstallErrorCode | "request_failed",
    message: string,
  ) {
    super(message);
    this.name = "SkillInstallRequestError";
  }
}

async function fetchSkillInstalls(): Promise<SkillInstallsResponse> {
  const res = await fetch("/api/agents/skill-installs");
  if (!res.ok) throw new Error(`skill installs fetch failed (${res.status})`);
  return (await res.json()) as SkillInstallsResponse;
}

// ── Queries ─────────────────────────────────────────────────────────

/**
 * Where libi installed its skills for the user's own agents. `poll` re-reads
 * every 5 s while the document is visible: the rows change from the server's
 * own syncs (a skill edit, a boot) and from `libi connect` in a terminal.
 */
export function useSkillInstalls({ poll = false }: { poll?: boolean } = {}): UseQueryResult<SkillInstallsResponse> {
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: skillInstallKeys.all,
    queryFn: fetchSkillInstalls,
    refetchInterval: poll && visible ? 5000 : false,
  });
}

/** One agent's rows: its user-level install (at most one) and its folders. */
export function installsFor(
  data: SkillInstallsResponse | undefined,
  agentId: SetupAgentId,
): { user: SkillInstallView | null; folders: SkillInstallView[] } {
  const mine = data?.installs.filter((i) => i.agentId === agentId) ?? [];
  return { user: mine.find((i) => i.scope === "user") ?? null, folders: mine.filter((i) => i.scope === "folder") };
}

// ── Mutations ───────────────────────────────────────────────────────

/**
 * Marks the list stale after an add or remove settles. Every mounted
 * observer refetches at once, and refetching an active query defaults to
 * `cancelRefetch: true`: a 5 s poll that left BEFORE the POST/DELETE is
 * cancelled, so its pre-mutation rows can never land after the mutation's
 * (a removed row showing again made a second Remove 404, and a fresh Install
 * dropped the wizard back from its summary to the choice). `fetchQuery` is
 * wrong here for exactly that reason — it dedupes onto the in-flight poll.
 * With nothing mounted, the invalidated entry refetches on its next mount.
 *
 * Returned (not fired-and-forgotten) so `onSettled` can hand it back to
 * TanStack, which awaits it before `mutateAsync` resolves — callers that
 * `await add.mutateAsync(...)` see the refreshed list already in the cache.
 */
function refreshSkillInstalls(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  // Best-effort: a failed background refresh leaves the list stale until the
  // next poll or mount; the mutation's caller already has its own result.
  return qc.invalidateQueries({ queryKey: skillInstallKeys.all }).catch(() => {});
}

export function useAddSkillInstall(): UseMutationResult<SkillInstallView, SkillInstallRequestError, AddSkillInstallRequest> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddSkillInstallRequest): Promise<SkillInstallView> => {
      const res = await fetch("/api/agents/skill-installs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => ({}))) as {
        install?: SkillInstallView;
        error?: SkillInstallErrorCode;
        message?: string;
      };
      if (!res.ok || !body.install) {
        throw new SkillInstallRequestError(body.error ?? "request_failed", body.message ?? `Couldn't install libi's skills (${res.status}).`);
      }
      return body.install;
    },
    onSettled: () => refreshSkillInstalls(qc),
  });
}

export function useRemoveSkillInstall(): UseMutationResult<{ removed: number }, SkillInstallRequestError, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<{ removed: number }> => {
      const res = await fetch(`/api/agents/skill-installs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: SkillInstallErrorCode; message?: string } | null;
        if (!body) {
          throw new SkillInstallRequestError("request_failed", "Couldn't remove libi's skills. Try again.");
        }
        const fallback = res.status === 404 ? "That install is already gone." : `Couldn't remove libi's skills (${res.status}).`;
        throw new SkillInstallRequestError(body.error ?? "request_failed", body.message ?? fallback);
      }
      return (await res.json()) as { removed: number };
    },
    onSettled: () => refreshSkillInstalls(qc),
  });
}
