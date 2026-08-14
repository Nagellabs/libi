// mcp/tools/effect-package-tools.ts
// Thin ToolResult wrappers over lib/effects/install-from-git. Validation /
// compile failures surface the underlying error in data.hint so the agent can
// fix the manifest or animate body and retry.
import type { ToolResult } from "./types";
import {
  installEffectFromGit,
  addEffect,
  updateEffect,
  removeEffect,
  listEffectPackages,
} from "@/lib/effects/install-from-git";
import {
  customEffectManifestSchema,
  type CustomEffectManifest,
} from "@/lib/effects/package-types";

/** Install a custom effect package from a git repo (manifest.json + animate.js). */
export async function installEffectFromGitTool(params: {
  url: string;
}): Promise<ToolResult> {
  const r = await installEffectFromGit({ url: params.url });
  if (!r.ok) {
    return {
      success: false,
      error: "install_failed",
      data: { hint: r.error },
    };
  }
  return { success: true, data: { id: r.id } };
}

/** Add (author) a custom effect package directly from agent-supplied fields. */
export async function addEffectTool(params: {
  id: string;
  name: string;
  family: string;
  phases: string[];
  supports: string[];
  params?: unknown[];
  defaultDurationMs?: number;
  source: string;
}): Promise<ToolResult> {
  const parsed = customEffectManifestSchema.safeParse({
    id: params.id,
    name: params.name,
    family: params.family,
    phases: params.phases,
    supports: params.supports,
    params: params.params ?? [],
    defaultDurationMs: params.defaultDurationMs,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: "invalid_manifest",
      data: { hint: parsed.error.message },
    };
  }
  const r = await addEffect({ manifest: parsed.data, source: params.source });
  if (!r.ok) {
    return { success: false, error: "invalid_effect", data: { hint: r.error } };
  }
  return { success: true, data: { id: r.id } };
}

/** Update an existing custom effect package's source and/or manifest fields.
 *  The `manifest` patch is intentionally a loose record here — the MCP schema
 *  widens enum members to `string`, and `updateEffect` re-validates the MERGED
 *  manifest via `customEffectManifestSchema`, so the narrow types are enforced
 *  there (a bad enum value returns a structured error, never persists). */
export async function updateEffectTool(params: {
  id: string;
  source?: string;
  manifest?: Record<string, unknown>;
}): Promise<ToolResult> {
  const r = await updateEffect({
    id: params.id,
    source: params.source,
    manifest: params.manifest as Partial<CustomEffectManifest> | undefined,
  });
  if (!r.ok) {
    return { success: false, error: "update_failed", data: { hint: r.error } };
  }
  return { success: true, data: { id: r.id } };
}

/** Remove a custom effect package by id. */
export async function removeEffectTool(params: { id: string }): Promise<ToolResult> {
  const r = await removeEffect({ id: params.id });
  if (!r.ok) {
    return { success: false, error: "remove_failed", data: { hint: r.error } };
  }
  return { success: true, data: { id: r.id } };
}

/** List on-disk custom effect packages with their validity. */
export async function listEffectPackagesTool(): Promise<ToolResult> {
  const packages = await listEffectPackages();
  return { success: true, data: { packages } };
}
