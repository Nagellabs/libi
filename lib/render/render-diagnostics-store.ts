/**
 * Body-layer failures per piece (spec §4.7). In memory, not the DB — they are
 * transient — and libi.get_piece_state reads them over HTTP (the MCP child is
 * another process). Bounded per piece.
 *
 * TWO WRITERS, kept apart (Task 10). The open preview PUTs "every body failure
 * I see right now" — a replace. An export or `libi.render_overlay_frames`
 * reports what ITS pass rendered — a merge. Held in one list, the preview's
 * next debounced PUT (a paused player that never drew the failing frame)
 * would silently wipe what the export just found. So each writer owns a list:
 * a PUT replaces only the preview's, an export merges only into its own, and a
 * read returns, per overlay, the newer of the two.
 *
 * An export entry names the SOURCE it failed on (`sourceHash`). It is shown
 * only while that is still the overlay's current draft body: once the agent
 * saves a fix it disappears without anyone having to clear it, and a render
 * of an older body (`source: "snapshot"`) never files a failure against the
 * draft. And a clean export pass retires what it disproves (see
 * `applyExportDiagnostics`) — which is how an agent confirms a fix with
 * `libi.render_overlay_frames` when no editor is open.
 *
 * Each writer keeps two lists. `RenderDiagnostic` names the overlay whose body
 * failed. An UNATTRIBUTED diagnostic is a runtime failure nothing ties to one
 * overlay (an untagged async throw, a CSP refusal, a font that would not
 * install — protocol `unattributed`): it gets a piece-level list rather than a
 * made-up overlayId, so every per-overlay record keeps a real one. Nothing can
 * clear an unattributed entry (there is no body whose recovery it waits on),
 * so it ages out after {@link UNATTRIBUTED_TTL_MS}.
 */
import { z } from "zod";
import {
  MAX_DIAGNOSTICS_PER_PIECE,
  MAX_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_UNATTRIBUTED_PER_PIECE,
  UNATTRIBUTED_TTL_MS,
  type CleanLayerFrames,
  type ExportDiagnosticsReport,
  type ExportRenderDiagnostic,
  type RenderDiagnostic,
  type UnattributedRenderDiagnostic,
} from "./render-diagnostics-types";

export * from "./render-diagnostics-types";

export const renderDiagnosticSchema = z.object({
  overlayId: z.string().min(1).max(200),
  kind: z.enum(["code", "three", "tracked"]),
  phase: z.enum(["compile", "build", "render"]),
  message: z.string().max(MAX_DIAGNOSTIC_MESSAGE_CHARS),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  time: z.number().nonnegative().optional(),
  frame: z.number().int().nonnegative().optional(),
  at: z.number(),
});

export const exportRenderDiagnosticSchema = renderDiagnosticSchema.extend({
  sourceHash: z.string().min(1).max(128).optional(),
});

export const unattributedDiagnosticSchema = z.object({
  message: z.string().max(MAX_DIAGNOSTIC_MESSAGE_CHARS),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  at: z.number(),
});

/** Clean runs per report: one per body overlay, each a handful of ranges. */
const MAX_CLEAN_OVERLAYS = 500;
const MAX_CLEAN_RANGES = 256;

const cleanFramesSchema = z.object({
  overlayId: z.string().min(1).max(200),
  sourceHash: z.string().min(1).max(128),
  frames: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).max(MAX_CLEAN_RANGES),
});

const reportSchema = z.object({
  fps: z.number().positive().max(1000),
  diagnostics: z.array(z.unknown()).max(MAX_DIAGNOSTICS_PER_PIECE),
  unattributed: z.array(z.unknown()).max(MAX_UNATTRIBUTED_PER_PIECE),
  clean: z.array(z.unknown()).max(MAX_CLEAN_OVERLAYS),
});

/** The preview's list (PUT replaces it). */
const store = new Map<string, RenderDiagnostic[]>();
/** Exports' and render_overlay_frames' list (merged into). */
const exportStore = new Map<string, ExportRenderDiagnostic[]>();
const unattributedStore = new Map<string, UnattributedRenderDiagnostic[]>();
const exportUnattributedStore = new Map<string, UnattributedRenderDiagnostic[]>();

/** Answers "what is overlay X's current draft body?" by its hash; undefined
 *  for an overlay the draft no longer has (or never had a body). */
export type CurrentSourceHash = (overlayId: string) => string | undefined;

export function parseRenderDiagnostics(raw: unknown): RenderDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: RenderDiagnostic[] = [];
  for (const item of raw) {
    const r = renderDiagnosticSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** The render page's `renderDiagnostics` postback, shape-checked entry by
 *  entry (a malformed entry drops itself, not the report). Null when the
 *  envelope itself is wrong. */
export function parseExportDiagnosticsReport(raw: unknown): ExportDiagnosticsReport | null {
  const env = reportSchema.safeParse(raw);
  if (!env.success) return null;
  const keep = <T,>(items: unknown[], schema: z.ZodType<T>): T[] =>
    items.flatMap((item) => {
      const r = schema.safeParse(item);
      return r.success ? [r.data] : [];
    });
  return {
    fps: env.data.fps,
    diagnostics: keep(env.data.diagnostics, exportRenderDiagnosticSchema),
    unattributed: keep(env.data.unattributed, unattributedDiagnosticSchema),
    clean: keep(env.data.clean, cleanFramesSchema) as CleanLayerFrames[],
  };
}

/** A piece with nothing to report holds no entry: every piece a preview ever
 *  opened would otherwise keep an empty one for the life of the process. */
function setOrDrop<T>(map: Map<string, T[]>, pieceId: string, list: T[]): void {
  if (list.length) map.set(pieceId, list);
  else map.delete(pieceId);
}

/** The preview's PUT: replaces the PREVIEW's list only — never an export's. */
export function setRenderDiagnostics(pieceId: string, diagnostics: RenderDiagnostic[]): void {
  setOrDrop(store, pieceId, diagnostics.slice(0, MAX_DIAGNOSTICS_PER_PIECE));
}

/** An export's findings: upsert into the EXPORT list by overlay, newest `at` wins. */
export function mergeRenderDiagnostics(pieceId: string, diagnostics: ExportRenderDiagnostic[]): void {
  const byId = new Map((exportStore.get(pieceId) ?? []).map((d) => [d.overlayId, d]));
  for (const d of diagnostics) {
    const prev = byId.get(d.overlayId);
    if (!prev || d.at >= prev.at) byId.set(d.overlayId, d);
  }
  setOrDrop(exportStore, pieceId, Array.from(byId.values()).slice(0, MAX_DIAGNOSTICS_PER_PIECE));
}

/** True when either writer holds something for the piece. */
export function hasRenderDiagnostics(pieceId: string): boolean {
  return store.has(pieceId) || exportStore.has(pieceId);
}

/**
 * The piece's diagnostics, one per overlay: the newer of the preview's and the
 * export's. With `currentSourceHash`, an export entry whose body has since
 * been replaced is dropped for good — the failure it describes is not the
 * body in the file any more. Without it (no manifest to compare against)
 * every entry is returned.
 */
export function getRenderDiagnostics(pieceId: string, currentSourceHash?: CurrentSourceHash): RenderDiagnostic[] {
  let exported = exportStore.get(pieceId) ?? [];
  if (currentSourceHash) {
    const live = exported.filter((d) => !d.sourceHash || currentSourceHash(d.overlayId) === d.sourceHash);
    if (live.length !== exported.length) setOrDrop(exportStore, pieceId, live);
    exported = live;
  }
  const byId = new Map<string, RenderDiagnostic>();
  for (const d of store.get(pieceId) ?? []) byId.set(d.overlayId, d);
  for (const d of exported) {
    const prev = byId.get(d.overlayId);
    if (prev && prev.at > d.at) continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sourceHash, ...record } = d;
    byId.set(d.overlayId, record);
  }
  return Array.from(byId.values()).slice(0, MAX_DIAGNOSTICS_PER_PIECE);
}

function inRanges(frame: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => frame >= start && frame < end);
}

/**
 * What a clean pass disproves, for one overlay whose rendered source IS its
 * current draft body: a `compile`/`build` entry (the body just compiled and
 * built), and a `render` entry whose frame this pass drew without an error —
 * "same overlay, same source, same frame". The entry's `frame` names it
 * exactly; one without (an older sender) is the frame nearest its ms-rounded
 * `time`. A `render` entry with neither (an async escape, a timeout) names no
 * frame, so no pass can disprove it; it goes when the body changes.
 */
function disproved(d: RenderDiagnostic, clean: CleanLayerFrames, fps: number): boolean {
  if (d.overlayId !== clean.overlayId) return false;
  if (d.phase !== "render") return true;
  const frame = d.frame ?? (d.time !== undefined ? Math.round(d.time * fps) : undefined);
  return frame !== undefined && inRanges(frame, clean.frames);
}

/**
 * Apply an export's (or `libi.render_overlay_frames`') report (spec §4.7):
 *  1. retire every entry — in BOTH lists — that a clean frame of the current
 *     body disproves (see `disproved`). An open preview that still sees the
 *     failure re-reports it with its next PUT; it is the authority on what it
 *     draws, so that is right.
 *  2. merge the pass's failures into the export list — only those about the
 *     current draft body; a render of another source says nothing about it.
 *  3. merge its unattributed diagnostics into the export's piece-level list.
 */
export function applyExportDiagnostics(pieceId: string, report: ExportDiagnosticsReport, currentSourceHash: CurrentSourceHash): void {
  const current = report.clean.filter((c) => currentSourceHash(c.overlayId) === c.sourceHash);
  if (current.length) {
    const keep = (d: RenderDiagnostic) => !current.some((c) => disproved(d, c, report.fps));
    setOrDrop(store, pieceId, (store.get(pieceId) ?? []).filter(keep));
    setOrDrop(exportStore, pieceId, (exportStore.get(pieceId) ?? []).filter(keep));
  }
  const failures = report.diagnostics.filter((d) => !d.sourceHash || currentSourceHash(d.overlayId) === d.sourceHash);
  if (failures.length) mergeRenderDiagnostics(pieceId, failures);
  if (report.unattributed.length) mergeUnattributedDiagnostics(pieceId, report.unattributed);
}

function unattributedKey(d: UnattributedRenderDiagnostic): string {
  return JSON.stringify([d.message, d.line ?? null, d.column ?? null]);
}

/** Newest `at` per distinct diagnostic, oldest first, the newest cap kept. */
function newestUnattributed(lists: UnattributedRenderDiagnostic[][]): UnattributedRenderDiagnostic[] {
  const byKey = new Map<string, UnattributedRenderDiagnostic>();
  for (const d of lists.flat()) {
    const key = unattributedKey(d);
    const prev = byKey.get(key);
    if (!prev || d.at >= prev.at) byKey.set(key, d);
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_UNATTRIBUTED_PER_PIECE);
}

/** The preview's PUT: replace ITS unattributed list, keeping the newest entries. */
export function setUnattributedDiagnostics(pieceId: string, diagnostics: UnattributedRenderDiagnostic[]): void {
  const newestLast = [...diagnostics].sort((a, b) => a.at - b.at);
  setOrDrop(unattributedStore, pieceId, newestLast.slice(-MAX_UNATTRIBUTED_PER_PIECE));
}

/** An export's unattributed diagnostics, merged into the export's list. */
export function mergeUnattributedDiagnostics(pieceId: string, diagnostics: UnattributedRenderDiagnostic[]): void {
  setOrDrop(exportUnattributedStore, pieceId, newestUnattributed([exportUnattributedStore.get(pieceId) ?? [], diagnostics]));
}

/** The piece's unattributed diagnostics from both writers that occurred
 *  within the TTL, oldest first. */
export function getUnattributedDiagnostics(pieceId: string, now: number = Date.now()): UnattributedRenderDiagnostic[] {
  return newestUnattributed([unattributedStore.get(pieceId) ?? [], exportUnattributedStore.get(pieceId) ?? []]).filter(
    (d) => now - d.at <= UNATTRIBUTED_TTL_MS,
  );
}

/** The piece is gone (`deletePieceCompletely`). Only this process's store —
 *  the studio's, when the studio deletes; bounded and in memory either way. */
export function clearRenderDiagnostics(pieceId: string): void {
  store.delete(pieceId);
  exportStore.delete(pieceId);
  unattributedStore.delete(pieceId);
  exportUnattributedStore.delete(pieceId);
}

export function __storedPieceIdsForTests(): string[] {
  return Array.from(
    new Set([...store.keys(), ...exportStore.keys(), ...unattributedStore.keys(), ...exportUnattributedStore.keys()]),
  ).sort();
}

export function __resetRenderDiagnosticsForTests(): void {
  store.clear();
  exportStore.clear();
  unattributedStore.clear();
  exportUnattributedStore.clear();
}
