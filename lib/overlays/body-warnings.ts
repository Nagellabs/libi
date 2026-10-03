/**
 * The missing-name warning: names a code overlay's body reads that it does not
 * declare, that the runtime does not inject, and that the sandbox does not have.
 * `heart is not defined` reaches the agent at write time instead of as a failed
 * render (Dreams session: a sliced kit missed a helper).
 *
 * Non-blocking by design — the body is still written. PARSED, NEVER RUN
 * (`code-scope.ts`); every name and line is body-derived, so the tools that
 * surface it label it `textSource: "overlay body (untrusted)"`.
 *
 * Used by `libi.add_overlay` / `libi.update_overlay` (the result's `warnings`),
 * the codeFilePath watcher (`watcher.ts`, on every agent edit) and
 * `libi.get_piece_state` (`bodyWarnings`, always current).
 */
import { analyzeBody } from "./code-scope";
import { isBuiltinName, type BodyFamily } from "./body-scope";
import { getOverlayBody } from "./code-fields";
import type { PersistedOverlay } from "@/lib/composition/persistence";

/** Marks body-derived text wherever a warning reaches the agent. */
export const BODY_WARNING_TEXT_SOURCE = "overlay body (untrusted)";

/** At most this many names come back for one body; a hostile body cannot make the result large. */
export const MAX_BODY_WARNINGS = 20;

export interface BodyWarning {
  name: string;
  /** Where the body FIRST reads it, 1-based, the body file's own. */
  line: number;
}

/** The body family an overlay's code runs as, or null for an overlay with no code. */
export function bodyFamilyOf(o: Pick<PersistedOverlay, "kind"> & Record<string, unknown>): BodyFamily | null {
  if (o.kind === "code") return "draw";
  if (o.kind === "three") return "three";
  if (o.kind === "tracked" && (o.content as { kind?: string } | undefined)?.kind === "code") return "draw";
  return null;
}

/**
 * Names `source` reads that nothing defines, first read of each, in source
 * order. Empty for a body that does not parse (the validator reports that).
 */
export function findUndefinedNames(source: string, family: BodyFamily): BodyWarning[] {
  const res = analyzeBody(source);
  if (!res.ok) return [];
  const seen = new Set<string>();
  const out: BodyWarning[] = [];
  for (const r of res.analysis.free) {
    if (seen.has(r.name) || isBuiltinName(r.name, family)) continue;
    seen.add(r.name);
    out.push({ name: r.name.slice(0, 80), line: r.line });
    if (out.length >= MAX_BODY_WARNINGS) break;
  }
  return out;
}

export interface OverlayBodyWarnings {
  overlayId: string;
  kind: string;
  warnings: BodyWarning[];
}

/** The warnings of every code-bearing overlay in `overlays` that has any. */
export function bodyWarningsForOverlays(overlays: readonly PersistedOverlay[]): OverlayBodyWarnings[] {
  const out: OverlayBodyWarnings[] = [];
  for (const o of overlays) {
    const family = bodyFamilyOf(o as never);
    const body = family ? getOverlayBody(o) : null;
    if (!family || !body) continue;
    const warnings = findUndefinedNames(body, family);
    if (warnings.length > 0) out.push({ overlayId: o.id, kind: o.kind, warnings });
  }
  return out;
}
