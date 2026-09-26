/**
 * The hash of each overlay's CURRENT draft body — the same `sha256Hex` the
 * preview and the render page key the sandbox's compiled-body cache by — so
 * the diagnostics store can tell a failure of the body in the file from one of
 * a body the agent has since replaced (`render-diagnostics-store.ts`).
 */
import type { PersistedOverlay } from "@/lib/composition/persistence";
import { getOverlayBody } from "@/lib/overlays/code-fields";
import { sha256Hex } from "@/lib/sandbox/hash";

export async function bodyHashesOf(overlays: readonly PersistedOverlay[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    overlays.map(async (o) => {
      const isBody = o.kind === "code" || o.kind === "three" || (o.kind === "tracked" && o.content.kind === "code");
      // `?? ""` exactly as the render page hashes a missing body.
      if (isBody) out.set(o.id, await sha256Hex(getOverlayBody(o) ?? ""));
    }),
  );
  return out;
}
