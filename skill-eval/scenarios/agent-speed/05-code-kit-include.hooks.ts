/**
 * Seed and verify hooks for `05-code-kit-include.md`.
 *
 * SEED: one 9:16 piece, "Tidewater (kit)": a 20 s backdrop and an "Intro card" at 0–4 s whose code body is a
 * ~190-line style kit (palette `P`, fonts `FONT`, layout constants, common helpers such as `textAt`, `badge`,
 * `vignette`, five style helpers, a scene) from the Dreams benchmark (`dreams-six-pieces-hard.kit.ts`, "01 Neon").
 *
 * VERIFY (outcomes only): a NEW code overlay at 16–20 s whose body says "See you Friday" and "NEXT WEEK", carries the
 * kit's palette literal and at least two of the kit's own helper declarations (it reused the kit instead of
 * redrawing the look), renders a real frame with no render diagnostics (no name left undefined), and the
 * "Intro card" body is byte-for-byte what was seeded.
 */
import { readFileSync } from "node:fs";
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";
import { KIT_STYLES, endCardBody } from "../_bench/dreams-six-pieces-hard.kit";
import { BACKDROP_BODY, call, f2, near, readManifest, runTool, withRollup, type Manifest } from "./_shared";

export const PIECE_NAME = "Tidewater (kit)";
export const TEXT = "See you Friday";
export const BADGE = "NEXT WEEK";
const STYLE = KIT_STYLES[0];
/** Declarations the seeded kit defines; a new body that reuses it has copied some of them. */
export const KIT_DECLARATIONS = [/\bfunction textAt\b/, /\bfunction badge\b/, /\bfunction vignette\b/, /\bfunction withAlpha\b/, /\bfunction divider\b/, /\bconst smoothOut\b/, /\bconst clamp\b/, /\bconst FONT\b/] as const;

export interface SeedState {
  pieceId: string;
  introCardId: string;
  backdropId: string;
}

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const { base } = ctx;
  const p = ctx.pieceId;
  await call(base, "PATCH", `/api/pieces/${p}`, { name: PIECE_NAME });
  await call(base, "PATCH", `/api/pieces/${p}/composition/dimensions`, { width: 1080, height: 1920 });
  const backdrop = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p, kind: "code", startTime: 0, duration: 20, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: BACKDROP_BODY, displayName: "Backdrop", z: 0,
  });
  const intro = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p, kind: "code", startTime: 0, duration: 4, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: endCardBody(STYLE), displayName: "Intro card", z: 3,
  });
  await call(base, "POST", `/api/pieces/${p}/snapshot/commit`, { summary: "Seeded" });
  return { placeholders: { piece: PIECE_NAME }, state: { pieceId: p, introCardId: intro.overlayId, backdropId: backdrop.overlayId } };
}

/** What the checks read about the new overlay's body. Exported for the unit test. */
export function checkBody(body: string): StateCheck[] {
  const declared = KIT_DECLARATIONS.filter((re) => re.test(body)).length;
  return [
    { name: "the new card says \"See you Friday\" with the \"NEXT WEEK\" badge", pass: body.includes(TEXT) && body.includes(BADGE), detail: `${body.length} chars` },
    { name: "it carries the kit's palette", pass: body.includes(STYLE.palette.accent) && body.includes(STYLE.palette.bg), detail: `accent ${STYLE.palette.accent} ${body.includes(STYLE.palette.accent) ? "found" : "missing"}, bg ${STYLE.palette.bg} ${body.includes(STYLE.palette.bg) ? "found" : "missing"}` },
    { name: "it reuses at least two of the kit's own helpers", pass: declared >= 2, detail: `${declared} kit declaration(s) in the new body` },
  ];
}

async function codeFileOf(base: string, pieceId: string, overlayId: string): Promise<string> {
  const data = await runTool<{ overlays?: Array<{ id: string; codeFilePath?: string }> }>(base, "libi.get_overlays", { pieceId });
  const hit = data.overlays?.find((o) => o.id === overlayId)?.codeFilePath;
  if (!hit) throw new Error(`no code file for overlay ${overlayId}`);
  return hit;
}

export function checkPlacement(manifest: Manifest, ids: SeedState): { checks: StateCheck[]; newId?: string } {
  const code = (manifest.overlays ?? []).filter((o) => o.kind === "code" && o.id !== ids.introCardId && o.id !== ids.backdropId);
  const card = code.find((o) => near(o.startTime, 16) && near(o.duration, 4)) ?? code[0];
  return {
    newId: card?.id,
    checks: [
      { name: "a new code overlay sits at 16-20 s", pass: !!card && near(card.startTime, 16) && near(card.duration, 4), detail: card ? `new overlay ${f2(card.startTime)}+${f2(card.duration)} (${code.length} new code overlay(s))` : "no new code overlay" },
    ],
  };
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  const out: StateCheck[] = [];
  try {
    const manifest = await readManifest(ctx.base, state.pieceId);
    const placed = checkPlacement(manifest, state);
    out.push(...placed.checks);
    if (placed.newId) {
      out.push(...checkBody(readFileSync(await codeFileOf(ctx.base, state.pieceId, placed.newId), "utf8")));
      const res = (await call(ctx.base, "POST", "/api/render/frames", { pieceId: state.pieceId, atTimes: [18] })) as { renderDiagnostics?: unknown[] };
      const g = (await call(ctx.base, "GET", `/api/pieces/${state.pieceId}/render-diagnostics`)) as { diagnostics?: unknown[]; unattributed?: unknown[] };
      const all = [...(res.renderDiagnostics ?? []), ...(g.diagnostics ?? []), ...(g.unattributed ?? [])];
      out.push({ name: "a real frame of the new card renders with no diagnostics", pass: all.length === 0, detail: all.length === 0 ? "no diagnostics" : `${all.length}: ${JSON.stringify(all[0]).slice(0, 300)}` });
    }
    const intro = readFileSync(await codeFileOf(ctx.base, state.pieceId, state.introCardId), "utf8");
    out.push({ name: "the Intro card body is untouched", pass: intro.trim() === endCardBody(STYLE).trim(), detail: `${intro.length} chars` });
  } catch (e) {
    out.push({ name: "state readable", pass: false, detail: (e as Error).message });
  }
  return withRollup("the new end card reuses the kit and renders", out);
}
