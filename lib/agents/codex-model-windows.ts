/**
 * Reads Codex's own model-list cache (`$CODEX_HOME/models_cache.json`) for the
 * per-model MAXIMUM context window a user could get by raising Codex's own
 * context-window setting — never the window Codex actually uses today.
 *
 * Codex runs a chat inside `context_window × effective_context_window_percent
 * / 100` (e.g. 272000 × 95% = 258400 for gpt-6-sol), which is what
 * `usage_update.size` reports and what `lib/sessions/model-window-cache.ts`
 * learns across processes. `max_context_window` (e.g. 872000) is the ceiling
 * a raised setting could reach — CW-1 shows it beside the window Codex uses,
 * never in place of it. See
 * docs-local/superpowers/sdd/2026-09-27-next-week-queue/brief-CW-1.md.
 *
 * READ-ONLY, defensively so: this is Codex's private cache, not libi's
 * (AGENTS.md — libi never writes an agent's config, and this module never
 * creates, writes or touches anything under CODEX_HOME). Missing, unreadable,
 * oversize, not JSON, or the wrong shape all resolve to an empty map — never a
 * throw — with one `debug` log naming the reason.
 *
 * Memoized by the file's (mtimeMs, size) so the hot path (every Codex
 * `usage_update` merge, in `lib/agents/session-event-handler.ts`) doesn't
 * stat-and-reparse per call, yet a genuine cache refresh (Codex re-fetching
 * its model list) is picked up on the next read. The memo lives on a
 * globalThis slot because the production bundle loads this module more than
 * once (see `lib/agents/cli/resolve.ts` for the identical pattern) — a
 * module-local variable would give each copy its own, silently stale, memo.
 */
import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { resolveCodexHome } from "@/lib/codex-config/canonical";

const FILE_NAME = "models_cache.json";

/** Above this the file is treated as unreadable rather than parsed — Codex's
 *  real cache is a few KB per model; anything past this is not a file worth
 *  JSON.parse-ing synchronously on a hot path. */
const MAX_BYTES = 2 * 1024 * 1024;

export interface CodexModelWindow {
  /** `context_window` — the model's window before Codex's effective-percent cut. */
  contextWindow: number;
  /** `max_context_window`, or null when absent/invalid. */
  maxContextWindow: number | null;
}

interface Memo {
  file: string;
  mtimeMs: number;
  size: number;
  windows: Map<string, CodexModelWindow>;
}

const MEMO_SLOT = Symbol.for("libi.codexModelWindows.memo");
const shared = ((globalThis as Record<symbol, unknown>)[MEMO_SLOT] ??= {
  memo: null,
}) as { memo: Memo | null };

export interface ReadCodexModelWindowsOpts {
  /** Default `resolveCodexHome()`. */
  codexHome?: string;
}

function finitePositive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function debugUnreadable(reason: string): void {
  logger.debug(
    { tag: "codex-config", op: "models_cache_unreadable", reason: reason.slice(0, 200) },
    "codex models_cache.json unreadable; treating its model windows as unknown",
  );
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read `<codexHome>/models_cache.json` and return the per-slug window info.
 * Empty map on anything but a clean read of a well-shaped file (see the
 * header) — never throws, never writes.
 */
export function readCodexModelWindows(
  opts: ReadCodexModelWindowsOpts = {},
): Map<string, CodexModelWindow> {
  const codexHome = opts.codexHome ?? resolveCodexHome();
  const file = path.join(codexHome, FILE_NAME);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    debugUnreadable(reasonOf(err));
    return new Map();
  }

  if (stat.size > MAX_BYTES) {
    debugUnreadable(`file too large (${stat.size} bytes)`);
    return new Map();
  }

  const memo = shared.memo;
  if (memo && memo.file === file && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
    return memo.windows;
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(file, "utf-8");
    raw = JSON.parse(text);
  } catch (err) {
    debugUnreadable(reasonOf(err));
    return new Map();
  }

  const models =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as { models?: unknown }).models
      : undefined;
  if (!Array.isArray(models)) {
    debugUnreadable("wrong shape: no models array");
    return new Map();
  }

  const windows = new Map<string, CodexModelWindow>();
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.slug !== "string" || e.slug.length === 0) continue;
    const contextWindow = finitePositive(e.context_window);
    if (contextWindow === null) continue;
    windows.set(e.slug, {
      contextWindow,
      maxContextWindow: finitePositive(e.max_context_window),
    });
  }

  shared.memo = { file, mtimeMs: stat.mtimeMs, size: stat.size, windows };
  return windows;
}

/**
 * The model's supported MAXIMUM window, or null when unknown. `modelId` may
 * arrive as a bare slug or `slug/<effort>` (the session's current model id vs.
 * the learned-window file's bare-slug key, `lib/sessions/model-window-cache.ts`)
 * — a `/…` suffix is stripped before lookup.
 */
export function codexMaxWindowFor(
  modelId: string,
  opts: ReadCodexModelWindowsOpts = {},
): number | null {
  const slug = modelId.split("/")[0] || modelId;
  return readCodexModelWindows(opts).get(slug)?.maxContextWindow ?? null;
}
