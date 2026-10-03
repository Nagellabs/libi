/**
 * Seed and verify hooks for `01-batch-edit-apply-ops.md`.
 *
 * SEED: a folder of four 9:16 pieces that are copies of one another, so — like a real set of variants —
 * they share every overlay id: a 4 s title "Spring Sale" (white), a subline "Free shipping on every
 * order" (its colour differs per piece, the piece's "style"), and a full-length backdrop.
 *
 * VERIFY (outcomes only, never a tool sequence): in EVERY piece the title reads "Summer Sale", is 6 s
 * long from where it started and is #FFB703; and nothing else moved (the subline keeps its text, colour
 * and timing, the backdrop its length, no layer was added or lost).
 */
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";
import { BACKDROP_BODY, duplicatesOf, f2, folderWithFirstPiece, near, readManifest, runTool, sameColor, call, withRollup, type Manifest, type SeededPiece } from "./_shared";

export const FOLDER_NAME = "Spring Promo — 4 variants";
export const OLD_TITLE = "Spring Sale";
export const NEW_TITLE = "Summer Sale";
export const NEW_COLOR = "#FFB703";
export const NEW_DURATION = 6;
const SUBLINES = ["#FFFFFF", "#9AD1D4", "#F4A261", "#B8F2E6"] as const;

export interface SeedState {
  folderId: string;
  titleId: string;
  sublineId: string;
  backdropId: string;
  pieces: Array<SeededPiece & { sublineColor: string }>;
}

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const { base } = ctx;
  const p1 = ctx.pieceId;
  const names = ["A", "B", "C", "D"].map((s) => `Spring Promo · ${s}`);
  const folderId = await folderWithFirstPiece(ctx, FOLDER_NAME, names[0]);
  await call(base, "PATCH", `/api/pieces/${p1}/composition/dimensions`, { width: 1080, height: 1920 });

  const backdrop = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "code", startTime: 0, duration: 8, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: BACKDROP_BODY, displayName: "Backdrop", z: 0,
  });
  const title = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "text", startTime: 0, duration: 4, rect: { x: 90, y: 700, width: 900, height: 200 },
    content: OLD_TITLE, color: "#FFFFFF", displayName: "Title", z: 2,
  });
  const subline = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "text", startTime: 0.5, duration: 4, rect: { x: 90, y: 940, width: 900, height: 120 },
    content: "Free shipping on every order", color: SUBLINES[0], displayName: "Subline", z: 2,
  });
  const copies = await duplicatesOf(ctx, p1, folderId, names.slice(1));
  const pieces = [{ pieceId: p1, name: names[0], sublineColor: SUBLINES[0] as string }];
  for (const [i, c] of copies.entries()) {
    await runTool(base, "libi.update_overlay", { pieceId: c.pieceId, overlayId: subline.overlayId, color: SUBLINES[i + 1] });
    await call(base, "POST", `/api/pieces/${c.pieceId}/snapshot/commit`, { summary: "Seeded style" });
    pieces.push({ ...c, sublineColor: SUBLINES[i + 1] });
  }
  return {
    placeholders: { folder: FOLDER_NAME },
    state: { folderId, titleId: title.overlayId, sublineId: subline.overlayId, backdropId: backdrop.overlayId, pieces },
  };
}

/** All checks for one piece's composition. Exported for the unit test. */
export function checkPiece(manifest: Manifest, ids: Pick<SeedState, "titleId" | "sublineId" | "backdropId">, piece: { name: string; sublineColor: string }): StateCheck[] {
  const overlays = manifest.overlays ?? [];
  const out: StateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => out.push({ name: `${piece.name}: ${name}`, pass, detail });
  const title = overlays.find((o) => o.id === ids.titleId);
  const subline = overlays.find((o) => o.id === ids.sublineId);
  const backdrop = overlays.find((o) => o.id === ids.backdropId);
  check("title says Summer Sale", title?.content === NEW_TITLE, `content ${JSON.stringify(title?.content)}`);
  check("title is 6 s long, still starting at 0", !!title && near(title.startTime, 0) && near(title.duration, NEW_DURATION), title ? `title ${f2(title.startTime)}+${f2(title.duration)}` : "no title overlay");
  check("title is #FFB703", sameColor(title?.color, NEW_COLOR), `colour ${title?.color}`);
  check(
    "subline untouched",
    !!subline && subline.content === "Free shipping on every order" && sameColor(subline.color, piece.sublineColor) && near(subline.startTime, 0.5) && near(subline.duration, 4),
    subline ? `subline ${JSON.stringify(subline.content)} ${subline.color} ${f2(subline.startTime)}+${f2(subline.duration)}` : "no subline overlay",
  );
  check("backdrop untouched", !!backdrop && near(backdrop.startTime, 0) && near(backdrop.duration, 8), backdrop ? `backdrop ${f2(backdrop.startTime)}+${f2(backdrop.duration)}` : "no backdrop overlay");
  check("no layer added or lost", overlays.length === 3, `${overlays.length} overlay(s)`);
  return out;
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  const out: StateCheck[] = [];
  for (const p of state.pieces) {
    try {
      out.push(...checkPiece(await readManifest(ctx.base, p.pieceId), state, p));
    } catch (e) {
      out.push({ name: `${p.name}: composition readable`, pass: false, detail: (e as Error).message });
    }
  }
  return withRollup(`all ${state.pieces.length} pieces right`, out);
}
