/**
 * Seed and verify hooks for `04-template-reflow-overrides.md`.
 *
 * SEED: the harness's piece becomes "Tidewater (vertical)": 1080×1920, one full-length backdrop (20.5 s), so
 * the piece has a length and a place for a closing card (its last 4 s, 16.5–20.5). The "Closing card"
 * template (`skill-eval/fixtures/dreams-bench/closing-card`, authored for 1920×1080) is staged by the
 * scenario's `templates:` key.
 *
 * VERIFY (outcomes only): the card landed ONCE (one of each layer, none doubled), the logo left out, every
 * layer inside the 9:16 frame keyframed rects included, over the piece's last 4 s, the asked text in the
 * three slots, the headline #FFB703, the wordmark's own text untouched, and the piece's own backdrop and
 * length untouched.
 */
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";
import { BACKDROP_BODY, call, f2, near, readManifest, runTool, sameColor, withRollup, type Manifest, type Overlay, type Rect } from "./_shared";

export const PIECE_NAME = "Tidewater (vertical)";
export const FRAME = { width: 1080, height: 1920 } as const;
export const TOTAL = 20.5;
export const CARD = { duration: 4 } as const;
export const TEXT = { headline: "Out now", subline: "Tidewater Lights · The Bench Band", cta: "Listen on every platform" } as const;
export const HEADLINE_COLOR = "#FFB703";
const PREFIX = "Closing";

export interface SeedState {
  pieceId: string;
  backdropId: string;
}

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const p = ctx.pieceId;
  await call(ctx.base, "PATCH", `/api/pieces/${p}`, { name: PIECE_NAME });
  await call(ctx.base, "PATCH", `/api/pieces/${p}/composition/dimensions`, { width: FRAME.width, height: FRAME.height });
  const backdrop = await runTool<{ overlayId: string }>(ctx.base, "libi.add_overlay", {
    pieceId: p, kind: "code", startTime: 0, duration: TOTAL, rect: { x: 0, y: 0, width: FRAME.width, height: FRAME.height }, body: BACKDROP_BODY, displayName: "Backdrop", z: 0,
  });
  await call(ctx.base, "POST", `/api/pieces/${p}/snapshot/commit`, { summary: "Seeded" });
  return { placeholders: { piece: PIECE_NAME }, state: { pieceId: p, backdropId: backdrop.overlayId } };
}

const inFrame = (r: Rect | undefined): boolean =>
  !!r && r.x >= -1 && r.y >= -1 && r.x + r.width <= FRAME.width + 1 && r.y + r.height <= FRAME.height + 1 && r.width > 0 && r.height > 0;

function rectsOf(o: Overlay): Rect[] {
  return [...(o.rect ? [o.rect] : []), ...(o.keyframes?.rect?.keyframes ?? []).map((k) => k.value)];
}

/** All checks for the piece's composition. Exported for the unit test. */
export function checkPiece(manifest: Manifest, ids: SeedState): StateCheck[] {
  const overlays = manifest.overlays ?? [];
  const out: StateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => out.push({ name, pass, detail });
  const card = overlays.filter((o) => o.displayName?.startsWith(PREFIX));
  const named = (suffix: string) => card.filter((o) => (o.displayName ?? "").endsWith(suffix));
  const one = (suffix: string) => (named(suffix).length === 1 ? named(suffix)[0] : undefined);

  check(
    "the card landed once: one of each layer, the logo left out",
    ["Backdrop", "Wordmark", "Headline", "Subline", "Call to action"].every((s) => named(s).length === 1) && named("Logo").length === 0 && card.length === 5,
    `card layers: ${card.map((o) => o.displayName).join(", ") || "none"}`,
  );
  const outside = card.filter((o) => !rectsOf(o).every(inFrame));
  check("every card layer, keyframed rects included, is inside the 9:16 frame", card.length > 0 && outside.length === 0, outside.length ? `outside: ${outside.map((o) => `${o.displayName} ${JSON.stringify(rectsOf(o).find((r) => !inFrame(r)))}`).join("; ")}` : `${card.length} layer(s) inside ${FRAME.width}x${FRAME.height}`);
  const early = card.filter((o) => o.startTime < TOTAL - CARD.duration - 0.15 || o.startTime + o.duration > TOTAL + 0.15);
  check("the card plays over the piece's last 4 s", card.length > 0 && early.length === 0, early.length ? `outside 16.5-20.5: ${early.map((o) => `${o.displayName} ${f2(o.startTime)}+${f2(o.duration)}`).join("; ")}` : `${card.length} layer(s) within ${f2(TOTAL - CARD.duration)}-${f2(TOTAL)}`);
  check("headline says Out now, in #FFB703", one("Headline")?.content === TEXT.headline && sameColor(one("Headline")?.color, HEADLINE_COLOR), `headline ${JSON.stringify(one("Headline")?.content)} ${one("Headline")?.color}`);
  check("subline and call to action carry the asked text", one("Subline")?.content === TEXT.subline && one("Call to action")?.content === TEXT.cta, `subline ${JSON.stringify(one("Subline")?.content)}, cta ${JSON.stringify(one("Call to action")?.content)}`);
  check("the wordmark's own text is untouched", one("Wordmark")?.content === "TIDEWATER", `wordmark ${JSON.stringify(one("Wordmark")?.content)}`);
  const backdrop = overlays.find((o) => o.id === ids.backdropId);
  const end = Math.max(0, ...overlays.map((o) => o.startTime + o.duration));
  check("the piece's own backdrop and length are untouched", !!backdrop && near(backdrop.startTime, 0) && near(backdrop.duration, TOTAL) && near(end, TOTAL, 0.2), `backdrop ${f2(backdrop?.startTime)}+${f2(backdrop?.duration)}, piece ends ${f2(end)}`);
  return out;
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  try {
    return withRollup("closing card fitted and applied once", checkPiece(await readManifest(ctx.base, state.pieceId), state));
  } catch (e) {
    return [{ name: "composition readable", pass: false, detail: (e as Error).message }];
  }
}
