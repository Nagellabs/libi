import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import { loadManifest, EMPTY_MANIFEST, type CompositionManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { compareStates } from "@/lib/composition/lifecycle";
import { validateDrawFunction, validateThreeFunction } from "@/lib/ai/scene-validator";
import { overlayHasCode, getOverlayBody } from "./code-fields";
import { bodyFamilyOf, findUndefinedNames, type OverlayBodyWarnings } from "./body-warnings";

/** Validate edited overlay code, flip draft on divergence, notify the UI. */
export async function handleOverlayChange(pieceId: string): Promise<{ ok: boolean; bodyWarnings?: OverlayBodyWarnings[] }> {
  let manifest: CompositionManifest;
  try {
    manifest = await loadManifest(pieceId); // hydrates code from files
  } catch (err) {
    logger.warn({ err, pieceId, tag: "overlay", op: "watch_load_failed" }, "overlay watch load failed");
    return { ok: false };
  }

  // Validate each code overlay; emit overlay_error for the badge (non-blocking).
  // A body that validates is also checked for names it reads that nothing defines
  // (`heart is not defined` before it renders): logged, returned, and always current
  // in `libi.get_piece_state` `bodyWarnings`. Non-blocking: no badge, the draft flip below still runs.
  const bodyWarnings: OverlayBodyWarnings[] = [];
  for (const o of manifest.overlays ?? []) {
    if (!overlayHasCode(o)) continue;
    const body = getOverlayBody(o) ?? "";
    const v = o.kind === "three" ? validateThreeFunction(body) : validateDrawFunction(body);
    if (!v.valid) {
      logger.warn({ pieceId, overlayId: o.id, reason: v.error, tag: "overlay", op: "watch_invalid_code" }, "overlay code invalid");
      navigationEmitter.emit("overlay_error", { pieceId, overlayId: o.id, message: v.error ?? "invalid code" });
      continue;
    }
    const family = bodyFamilyOf(o as never);
    const warnings = family ? findUndefinedNames(body, family) : [];
    if (warnings.length > 0) {
      bodyWarnings.push({ overlayId: o.id, kind: o.kind, warnings });
      logger.warn(
        { pieceId, overlayId: o.id, names: warnings.map((w) => w.name), firstLine: warnings[0]!.line, tag: "overlay", op: "watch_undefined_names" },
        "overlay body reads names nothing defines",
      );
    }
  }

  // Draft-flip on divergence from the committed snapshot (mirror storyboard).
  try {
    const snap = (await loadCurrentSnapshot(pieceId)) ?? EMPTY_MANIFEST;
    if (compareStates(snap, manifest).totalChanges > 0) {
      const db = getDb();
      const [row] = await db.select({ hasDraft: pieces.hasDraft }).from(pieces).where(eq(pieces.id, pieceId));
      if (row && !row.hasDraft) {
        await db.update(pieces).set({ hasDraft: true, updatedAt: new Date() }).where(eq(pieces.id, pieceId));
        navigationEmitter.emit("refresh_query", { queryKey: "piece-state", pieceId });
      }
    }
  } catch (err) {
    logger.warn({ err, pieceId, tag: "overlay", op: "watch_draft_flip_skip" }, "overlay draft-flip skipped");
  }

  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return bodyWarnings.length > 0 ? { ok: true, bodyWarnings } : { ok: true };
}
