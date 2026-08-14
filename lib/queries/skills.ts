import { useMutation, useQuery, useQueryClient, type UseQueryResult, type UseMutationResult } from "@tanstack/react-query";

export interface SkillPromptUI {
  relPath: string;
  body: string;
}

export interface SkillUI {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "user";
  /** Only on user rows that override a bundled skill: true = bundled original
   *  changed since the fork, false = unchanged, "unknown" = pre-feature fork. */
  bundledUpdatedSinceFork?: boolean | "unknown";
  enabled: boolean;
  body: string | null;
  tags: string[];
  prompts: SkillPromptUI[];
}

export const skillKeys = {
  all: ["skills"] as const,
};

export type SkillFieldError = "name" | "description" | "body";

export class InstallSkillError extends Error {
  constructor(message: string, readonly field?: SkillFieldError) {
    super(message);
    this.name = "InstallSkillError";
  }
}

export function useSkills(): UseQueryResult<SkillUI[]> {
  return useQuery<SkillUI[]>({
    queryKey: skillKeys.all,
    queryFn: async () => {
      const res = await fetch("/api/settings/skills");
      if (!res.ok) throw new Error("Failed to load skills");
      const data = await res.json();
      return data.skills as SkillUI[];
    },
  });
}

/** A skill after collapsing a (bundled, user) override pair into one entry. */
export interface EffectiveSkill extends SkillUI {
  /** true when a user row shadows a bundled one of the same name. */
  overriddenFromBundled?: boolean;
}

/** Collapse (bundled, user) pairs sharing a name into one user-preferred entry. */
export function mergeByName(skills: SkillUI[]): EffectiveSkill[] {
  const byName = new Map<string, EffectiveSkill>();
  const bundledNames = new Set(
    skills.filter((s) => s.source === "bundled").map((s) => s.name),
  );
  for (const s of skills) {
    if (!byName.has(s.name) || s.source === "user") byName.set(s.name, { ...s });
  }
  for (const [, s] of byName) {
    if (s.source === "user" && bundledNames.has(s.name)) s.overriddenFromBundled = true;
  }
  return Array.from(byName.values());
}

/**
 * Fetch the FULL effective skill by name — including the bundled SKILL.md body
 * (read from disk), which the lean list endpoint omits. Keyed by name (stable
 * across fork/revert, which change the row id). The query key is prefixed with
 * "skills" so every skill mutation's `invalidateQueries(["skills"])` refreshes
 * it automatically.
 */
export function useSkillDetail(name: string): UseQueryResult<EffectiveSkill | null> {
  return useQuery<EffectiveSkill | null>({
    queryKey: [...skillKeys.all, "detail", name],
    queryFn: async () => {
      const res = await fetch(`/api/settings/skills/by-name/${encodeURIComponent(name)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to load skill");
      const data = await res.json();
      return data.skill as EffectiveSkill;
    },
  });
}

export function useInstallSkill(): UseMutationResult<{ skill: { id: string; name: string } }, Error, { name: string; description: string; body: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      const res = await fetch("/api/settings/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; field?: SkillFieldError };
        throw new InstallSkillError(j.error ?? "Install failed", j.field);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useUpdateSkill(): UseMutationResult<
  { skill: { id: string; name: string; description: string; enabled: boolean } },
  Error,
  { id: string; name: string; description: string; body: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }) => {
      const res = await fetch(`/api/settings/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          field?: SkillFieldError;
        };
        throw new InstallSkillError(j.error ?? "Update failed", j.field);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useToggleSkill(): UseMutationResult<unknown, Error, { id: string; enabled: boolean }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, enabled }) => {
      const res = await fetch(`/api/settings/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Toggle failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useDeleteSkill(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`/api/settings/skills/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Delete failed");
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useAddSkillPrompt(): UseMutationResult<unknown, Error, { id: string; name: string; body: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }) => {
      const res = await fetch(`/api/settings/skills/${id}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Add prompt failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useUpdateSkillPrompt(): UseMutationResult<unknown, Error, { id: string; name: string; body: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name, body }) => {
      const res = await fetch(`/api/settings/skills/${id}/prompts/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Update prompt failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useDeleteSkillPrompt(): UseMutationResult<unknown, Error, { id: string; name: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }) => {
      const res = await fetch(`/api/settings/skills/${id}/prompts/${name}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Delete prompt failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useUpdateSkillTags(): UseMutationResult<unknown, Error, { id: string; tags: string[] }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tags }) => {
      const res = await fetch(`/api/settings/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) throw new Error("Update tags failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useBulkSetSkillEnabled(): UseMutationResult<unknown, Error, { ids: string[]; enabled: boolean }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      const res = await fetch(`/api/settings/skills/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Bulk toggle failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useForkSkill(): UseMutationResult<{ id: string; name: string }, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`/api/settings/skills/${id}/fork`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Fork failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}
