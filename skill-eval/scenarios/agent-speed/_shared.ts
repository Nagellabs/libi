/**
 * Shared plumbing for the agent-speed scenarios' seed and verify hooks (`skill-eval/scenarios/agent-speed/`).
 *
 * Each scenario here is small on purpose: one new primitive, one outcome, a ceiling on how many tool calls it
 * may take (the ceiling is a `transcript_contains` count in the scenario, not a check here). The hooks build their
 * state over the studio's own routes and `/api/e2e/run-tool` (the agent's tool functions, validated as an agent's
 * call is) and read it back over HTTP. HTTP and fs only: nothing here may import `@/lib` (see ScenarioHooks in
 * scripts/skill-eval/types.ts).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";

export async function call(base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

/** One of the agent's tools, through the test-only route. */
export async function runTool<T = Record<string, unknown>>(base: string, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = (await call(base, "POST", "/api/e2e/run-tool", { tool, args })) as { success?: boolean; data?: T; error?: string };
  if (!r?.success) throw new Error(`${tool} failed: ${JSON.stringify(r).slice(0, 400)}`);
  return r.data as T;
}

export async function upload(base: string, pieceId: string, path: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)]), basename(path));
  form.append("name", name);
  const res = await fetch(`${base}/api/pieces/${pieceId}/upload`, { method: "POST", body: form });
  const json = (await res.json()) as { file?: { id: string }; error?: string };
  if (!res.ok || !json.file) throw new Error(`upload ${basename(path)} failed: ${res.status} ${json.error ?? ""}`);
  return json.file.id;
}

export async function waitForJob(base: string, jobId: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const s = (await call(base, "GET", `/api/jobs/${jobId}`)) as { status?: string; error?: unknown };
    if (s.status === "completed") return;
    if (s.status === "failed" || s.status === "cancelled") throw new Error(`job ${jobId} ${s.status}: ${JSON.stringify(s.error)}`);
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} still ${s.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function fixtureOf(ctx: ScenarioHookContext, name: string): string {
  const hit = ctx.fixtures.find((p) => basename(p) === name);
  if (!hit) throw new Error(`fixture ${name} was not staged (got ${ctx.fixtures.map((p) => basename(p)).join(", ")})`);
  return hit;
}

/** A new folder, with the harness's piece moved into it under `pieceName`. */
export async function folderWithFirstPiece(ctx: ScenarioHookContext, folderName: string, pieceName: string): Promise<string> {
  const folder = (await call(ctx.base, "POST", "/api/folders", { name: folderName })) as { id?: string; folder?: { id: string } };
  const folderId = folder.id ?? folder.folder?.id;
  if (!folderId) throw new Error(`create folder returned no id: ${JSON.stringify(folder)}`);
  await call(ctx.base, "PATCH", `/api/pieces/${ctx.pieceId}`, { name: pieceName, folderId });
  return folderId;
}

export interface SeededPiece {
  pieceId: string;
  name: string;
}

/** Commits piece `src`, then copies it into `folderId` once per name: copies share every overlay and clip id, as a real set of variants does. */
export async function duplicatesOf(ctx: ScenarioHookContext, src: string, folderId: string, names: string[]): Promise<SeededPiece[]> {
  await call(ctx.base, "POST", `/api/pieces/${src}/snapshot/commit`, { summary: "Seeded" });
  const out: SeededPiece[] = [];
  for (const name of names) {
    const dup = (await call(ctx.base, "POST", `/api/pieces/${src}/duplicate`, { name, folderId, source: "snapshot" })) as { pieceId: string; jobId: string };
    await waitForJob(ctx.base, dup.jobId);
    out.push({ pieceId: dup.pieceId, name });
  }
  return out;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Overlay {
  id: string;
  kind: string;
  displayName?: string;
  startTime: number;
  duration: number;
  rect?: Rect;
  fileId?: string;
  trim?: { start: number; end: number };
  content?: string;
  color?: string;
  keyframes?: { rect?: { keyframes?: Array<{ t: number; value: Rect }> } };
}
export interface Clip {
  id: string;
  kind: "inline" | "standalone";
  fileId: string;
  startTime: number;
  duration: number;
  volume: number;
  gainDb?: number;
  volumeKeyframes?: { keyframes: Array<{ t: number; value: number }> };
  enabled: boolean;
  linkedOverlayId?: string;
  duck?: { sidechainClipIds?: string[]; sidechainClipId?: string; reductionDb?: number };
}
export type Manifest = { overlays?: Overlay[]; audioClips?: Clip[] };

export async function readManifest(base: string, pieceId: string): Promise<Manifest> {
  const comp = (await call(base, "GET", `/api/pieces/${pieceId}/composition`)) as { manifest: Manifest };
  return comp.manifest;
}

export const near = (a: number | undefined, b: number, tol = 0.15): boolean => typeof a === "number" && Math.abs(a - b) <= tol;
export const f2 = (x: number | undefined): string => (typeof x === "number" ? x.toFixed(2) : String(x));
export const sameColor = (a: string | undefined, b: string): boolean => (a ?? "").toLowerCase() === b.toLowerCase();

/** Prepends a roll-up check ("all N pieces right"), the way the benchmark hooks do. */
export function withRollup(label: string, checks: StateCheck[]): StateCheck[] {
  const failed = checks.filter((c) => !c.pass);
  return [{ name: label, pass: failed.length === 0, detail: failed.length ? `${failed.length} check(s) failed` : "every check passed" }, ...checks];
}

/** A one-colour full-frame code body: a piece's backdrop, so the piece has a length. */
export const BACKDROP_BODY = `const { ctx, width: W, height: H } = context;
ctx.fillStyle = '#0B1E3A';
ctx.fillRect(0, 0, W, H);
`;
