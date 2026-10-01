import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { getOpenedPieceId } from "@/lib/editor-state";
import { dropProxyFile } from "./lifecycle";
import { pieceAndLibraryFiles } from "./piece-files";
import { forgetEvictedProxies, listEvictedProxies } from "./evicted";
import { isTestMode } from "@/lib/test-mode";

export interface ProxyEntry {
  fileId: string;
  bytes: number;
  /** Unix seconds. Older = evicted first. */
  generatedAt: number;
  /** Attached to a piece the user currently has open. Protected from eviction. */
  inUse: boolean;
  /** An audio file's proxy: evicted only after every video proxy not in use. */
  audio?: boolean;
}

/** Default disk budget for ready proxies — 4 GB. */
export const DEFAULT_PROXY_BYTE_BUDGET = 4 * 1024 * 1024 * 1024;

let budgetOverrideLogged: number | null = null;

/**
 * The budget in force: the default, or `LIBI_PROXY_BYTE_BUDGET` (whole bytes,
 * a positive integer) in a dev or test build only: an override for testing
 * eviction and the re-make on open (lib/proxy/ensure.ts) without filling
 * 4 GB. A production server (packaged, npx: NODE_ENV=production, not test
 * mode) ignores it, so a value left in a shell can't shrink a user's budget
 * (review m8). An override in force is logged once.
 */
export function proxyByteBudget(): number {
  const raw = process.env.LIBI_PROXY_BYTE_BUDGET?.trim();
  if (!raw) return DEFAULT_PROXY_BYTE_BUDGET;
  if (process.env.NODE_ENV === "production" && !isTestMode()) return DEFAULT_PROXY_BYTE_BUDGET;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_PROXY_BYTE_BUDGET;
  if (budgetOverrideLogged !== n) {
    budgetOverrideLogged = n;
    logger.info({ tag: "proxy", op: "budget_override", bytes: n }, "proxy.budget_override");
  }
  return n;
}

/**
 * Return the fileIds to evict (in order) to bring the total proxy
 * footprint at or below `byteBudget`. Prefers evicting non-in-use
 * oldest first, video proxies before audio ones; only evicts in-use
 * entries as a last resort, and never an in-use AUDIO proxy: without it the
 * preview plays silence or a misread for that file, where a video without
 * its proxy still plays its original (review m5). Those stay over budget.
 */
export function selectProxiesToEvict(entries: ProxyEntry[], byteBudget: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= byteBudget) return [];

  const sorted = [...entries].sort((a, b) => {
    // In-use entries sink to the end (evicted last).
    if (a.inUse !== b.inUse) return a.inUse ? 1 : -1;
    // Then video before audio: an audio file's proxy is the only audio the
    // preview can play for it, while a video without its proxy still plays.
    if (!!a.audio !== !!b.audio) return a.audio ? 1 : -1;
    // Then by age: older first.
    return a.generatedAt - b.generatedAt;
  });

  const toEvict: string[] = [];
  let remaining = total;
  for (const entry of sorted) {
    if (remaining <= byteBudget) break;
    if (entry.inUse && entry.audio) continue;
    toEvict.push(entry.fileId);
    remaining -= entry.bytes;
  }
  return toEvict;
}

export interface EvictOptions {
  /** Defaults to `proxyByteBudget()` (4 GB unless LIBI_PROXY_BYTE_BUDGET says otherwise). */
  byteBudget?: number;
  /** Defaults to `getLibiStorageDir()`. */
  storageBaseDir?: string;
  /** Set of fileIds protected from eviction (currently open in UI). Defaults to empty. */
  inUseFileIds?: Set<string>;
}

/**
 * Enumerate ready proxies, pass through `selectProxiesToEvict`, and drop
 * each chosen one via `dropProxyFile`. Called after every successful
 * proxy generation. Silent + cheap when under budget.
 *
 * Resolves the in-use set lazily so the runner doesn't have to know about
 * `editor-state`. Errors from individual statSync calls skip that entry
 * rather than aborting the sweep.
 */
let keptAudioLogged: string | null = null;

export function evictProxiesIfOverBudget(opts: EvictOptions = {}): void {
  const byteBudget = opts.byteBudget ?? proxyByteBudget();
  const storageBaseDir = opts.storageBaseDir ?? getLibiStorageDir();
  const inUse = opts.inUseFileIds ?? resolveInUseFileIds();

  const db = getDb();
  pruneEvictedRecords(db);
  const readyRows = db
    .select()
    .from(files)
    .where(eq(files.proxyStatus, "ready"))
    .all();
  if (readyRows.length === 0) return;

  const entries: ProxyEntry[] = [];
  for (const row of readyRows) {
    if (!row.proxyFilename) continue;
    // An audio file's proxy counts too (review round 5, M4: an ALAC library
    // kept ~580 MB per 100 songs for good). It goes only after every video
    // proxy not in use, and the piece's next open makes it again
    // (lib/proxy/ensure.ts).
    const proxyPath = path.join(
      storageBaseDir,
      row.pieceId ?? "_global",
      row.proxyFilename,
    );
    let bytes = 0;
    try {
      bytes = fs.statSync(proxyPath).size;
    } catch {
      continue;
    }
    entries.push({
      fileId: row.id,
      bytes,
      generatedAt: Math.floor((row.proxyGeneratedAt?.getTime() ?? 0) / 1000),
      inUse: inUse.has(row.id),
      audio: row.type === "audio",
    });
  }

  const toEvict = selectProxiesToEvict(entries, byteBudget);
  const left = entries.filter((e) => !toEvict.includes(e.fileId)).reduce((sum, e) => sum + e.bytes, 0);
  const keptAudio = entries.filter((e) => e.inUse && e.audio).map((e) => e.fileId).sort().join(",");
  if (left > byteBudget && keptAudio && keptAudioLogged !== keptAudio) {
    keptAudioLogged = keptAudio;
    logger.warn(
      { tag: "proxy", op: "evict_in_use_audio_kept", fileIds: keptAudio.split(","), bytes: left, budget: byteBudget },
      "proxy.evict_in_use_audio_kept: over budget, but the open piece's audio proxies are kept",
    );
  }
  for (const fileId of toEvict) {
    const entry = entries.find((e) => e.fileId === fileId);
    if (entry) {
      logger.info(
        {
          fileId,
          event: "evict",
          bytes: entry.bytes,
          ageMs: Date.now() - entry.generatedAt * 1000,
        },
        "proxy.evict",
      );
    }
    try {
      dropProxyFile(fileId, "lru");
    } catch (err) {
      logger.warn({ err, fileId }, "proxy.evict.drop_failed");
    }
  }
}

/** Forget eviction records (evicted.ts) whose file row is gone: a deleted piece's files. */
function pruneEvictedRecords(db: ReturnType<typeof getDb>): void {
  try {
    const ids = Object.keys(listEvictedProxies());
    if (ids.length === 0) return;
    const alive = new Set(db.select({ id: files.id }).from(files).where(inArray(files.id, ids)).all().map((r) => r.id));
    const gone = ids.filter((id) => !alive.has(id));
    if (gone.length > 0) forgetEvictedProxies(gone);
  } catch (err) {
    logger.warn({ tag: "proxy", op: "evicted_prune_failed", err: err instanceof Error ? err.message : String(err) }, "proxy.evicted_prune_failed");
  }
}

/**
 * Resolve the set of fileIds the currently-opened piece shows: its own files
 * and the library files its composition uses (evicting one of those would
 * only have it re-made on the next open: lib/proxy/ensure.ts).
 * Silent on failure (no opened piece, no DB, etc.).
 */
function resolveInUseFileIds(): Set<string> {
  try {
    const pieceId = getOpenedPieceId();
    if (!pieceId) return new Set();
    return new Set(pieceAndLibraryFiles(pieceId).map((r) => r.id));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "proxy.evict.in_use_resolution_failed",
    );
    return new Set();
  }
}
