/**
 * Persistent, learned map of (agentId, modelId) → context-window size.
 *
 * The adapter's own window cache is per-process, so every app launch replays
 * a stale default-window seed on the first turn of each large-context model
 * whose id/description carries no "1m" token (Fable). libi observes the
 * authoritative window every turn — the settled size at prompt completion —
 * so remembering it here lets the NEXT process seed the right denominator
 * from the first usage_update instead of waiting a whole turn.
 *
 * This is a display hint, not durable user data: losing the file costs one
 * turn of a plausible-but-low percent, nothing else. That is why it lives in
 * a JSON file under LIBI_HOME rather than the database — no migration, no
 * schema, safe to delete.
 *
 * Learning records the RAW size the adapter last reported (see
 * `SessionUsageState.reportedSize`), never a corrected value — recording a
 * correction would make the cache self-confirming and a genuine window
 * downgrade could never displace it.
 */
import fs from "node:fs";
import path from "node:path";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";

const FILE_NAME = "model-windows.json";

type CacheShape = Record<string, Record<string, number>>;

let cache: CacheShape | null = null;
let loadedFrom: string | null = null;

function cacheFilePath(): string {
  return path.join(getLibiHome(), FILE_NAME);
}

function load(): CacheShape {
  const file = cacheFilePath();
  if (cache !== null && loadedFrom === file) return cache;
  let next: CacheShape = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [agentId, models] of Object.entries(raw)) {
        if (typeof models !== "object" || models === null) continue;
        for (const [modelId, size] of Object.entries(models)) {
          if (typeof size === "number" && Number.isFinite(size) && size > 0) {
            (next[agentId] ??= {})[modelId] = size;
          }
        }
      }
    }
  } catch {
    // Missing or corrupt file — start empty; the next record rewrites it.
    next = {};
  }
  cache = next;
  loadedFrom = file;
  return next;
}

/** The last settled window for (agent, model), or null when never observed. */
export function getKnownWindow(agentId: string, modelId: string): number | null {
  return load()[agentId]?.[modelId] ?? null;
}

/**
 * Remember the settled window for (agent, model). No-ops on invalid sizes and
 * on values already recorded, so calling it after every turn is cheap.
 */
export function recordWindow(agentId: string, modelId: string, size: number): void {
  if (!agentId || !modelId) return;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return;
  const state = load();
  if (state[agentId]?.[modelId] === size) return;
  (state[agentId] ??= {})[modelId] = size;
  const file = cacheFilePath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    // Non-fatal — the in-memory value still serves this process.
    logger.warn(
      { tag: "session-manager", op: "model_window_cache_write_failed", err },
      "could not persist the learned context window",
    );
  }
}

/** Test seam: drop the in-memory state so the next read reloads from disk. */
export function resetModelWindowCacheForTests(): void {
  cache = null;
  loadedFrom = null;
}
