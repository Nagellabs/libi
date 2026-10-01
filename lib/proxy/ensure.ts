import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { canonicalHash } from "@/lib/jobs/canonical-hash";
import { findRunningByHash } from "@/lib/jobs/repo";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { regenerateProxy, regenerationInFlight } from "@/lib/proxy/regen-once";
import { pieceAndLibraryFiles } from "@/lib/proxy/piece-files";
import { forgetEvictedProxies, listEvictedProxies } from "@/lib/proxy/evicted";
import { proxyByteBudget } from "@/lib/proxy/lru";
import type { FileRecord } from "@/lib/db/schema/types";

/**
 * Re-make, when its piece is opened, a proxy the LRU budget evicted.
 *
 * `evictProxiesIfOverBudget` drops a proxy through `dropProxyFile(…, "lru")`,
 * which leaves the row `idle` with no proxy file. Nothing made it again: the
 * proxy route answers 404 for a row that isn't ready, and `proxyExpectation`
 * says "pending" for good. A plain `enqueueProxyGen` would not help either: it
 * dedupes on `(proxy_gen, {fileId})` and returns on `matching_completed`, the
 * evicted proxy's own earlier job. So this goes through `regenerateProxy`,
 * which forces past that completed job (and waits for any live one first).
 *
 * Only an EVICTED proxy is re-made (review I2): the LRU records each one it
 * drops (evicted.ts). An idle row the LRU never touched is left alone, video
 * or audio: its proxy may be skipped on purpose (the onboarding clips, stored
 * with `skipProxyGeneration` so a proxy landing never switches a first-time
 * user's film mid-playback), and an audio file only ever had one when the
 * preview needed it. The row must still be idle with no proxy, and its
 * original on disk. A video with alpha is re-made only when its codec (probed)
 * isn't VPx, the same rule as the proxy_gen runner, never by extension alone
 * (review m6).
 *
 * Never a loop (review I3). The LRU evicts a proxy of the open piece only as a
 * last resort, when the piece's own proxies don't fit the budget; re-making it
 * would evict another of them, whose re-make evicts the next, for as long as
 * the piece is open. So a re-make starts only if the piece's ready proxies
 * plus the evicted one's size fit the budget; otherwise it stays pending
 * (logged once per piece: `ensure_over_budget`), and its eviction record is
 * kept for when they do fit. An audio proxy skips that check (n4): the LRU
 * never evicts an in-use one, so it can't loop.
 *
 * Bounded, so an open never starts a burst:
 * - one pass per piece at a time (a second call while one runs shares it);
 * - at most `ENSURE_MAX_PER_PASS` regenerations started per pass (proxy_gen
 *   runs two at a time; each one's completion refreshes the piece, whose next
 *   GET starts the next few);
 * - a file this module re-made in the last `ENSURE_COOLDOWN_MS` is not re-made
 *   again by a later pass (the refreshes a completion or an eviction sends).
 *
 * The piece's files are its own rows plus the library (global) files its
 * composition uses: the preview reads both (`proxyStatusForFile`).
 *
 * **Next.js process only** (uses the in-process JobManager).
 */
export const ENSURE_MAX_PER_PASS = 4;
export const ENSURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * This process's passes, cooldowns and what was logged, on `globalThis` like
 * the JobManager: Next's dev server can evaluate this module again (HMR, a
 * route compiled on its own), and a fresh copy would forget a cooldown and
 * log "over budget" again on every refresh (seen live, review I3 check).
 */
interface EnsureState {
  passes: Map<string, Promise<string[]>>;
  remadeAt: Map<string, number>;
  /** Pieces whose "doesn't fit the budget" was logged, with the files it named. */
  overBudgetLogged: Map<string, string>;
}
declare global {
  var __libiEnsureProxies: EnsureState | undefined;
}
const state: EnsureState = (globalThis.__libiEnsureProxies ??= {
  passes: new Map(),
  remadeAt: new Map(),
  overBudgetLogged: new Map(),
});
const { passes, remadeAt, overBudgetLogged } = state;

/** Test hook: forget passes, cooldowns and what was logged. */
export function resetEnsureProxiesForTest(): void {
  passes.clear();
  remadeAt.clear();
  overBudgetLogged.clear();
}

function storagePath(file: FileRecord, name: string): string {
  return path.join(getLibiStorageDir(), file.pieceId ?? "_global", name);
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

async function pass(pieceId: string): Promise<string[]> {
  const evicted = listEvictedProxies();
  const rows = pieceAndLibraryFiles(pieceId);
  const budget = proxyByteBudget();
  // What the open piece's proxies already take: the LRU keeps them last.
  let inUseBytes = 0;
  for (const r of rows) {
    if (r.proxyStatus === "ready" && r.proxyFilename) inUseBytes += sizeOf(storagePath(r, r.proxyFilename));
  }

  const started: string[] = [];
  const stale: string[] = [];
  const overBudget: string[] = [];
  const now = Date.now();
  for (const file of rows) {
    const ev = evicted[file.id];
    if (!ev) continue; // never evicted: never re-made (I2)
    if (started.length >= ENSURE_MAX_PER_PASS) break;
    if (file.proxyStatus !== "idle" || file.proxyFilename || (file.type !== "video" && file.type !== "audio")) {
      if (file.proxyStatus !== "generating") stale.push(file.id); // made again, or failed, since
      continue;
    }
    if (!fs.existsSync(storagePath(file, file.filename))) continue;
    if (regenerationInFlight(file.id)) continue;
    const last = remadeAt.get(file.id);
    if (last !== undefined && now - last < ENSURE_COOLDOWN_MS) continue;
    if (await findRunningByHash("proxy_gen", canonicalHash({ fileId: file.id }))) continue;
    if (file.type === "video" && file.hasAlpha) {
      const probed = await probeMedia(storagePath(file, file.filename));
      if (alphaRecoverableInPreview({ hasAlpha: true, videoCodec: probed.videoCodec, filename: file.filename, contentType: file.contentType })) {
        stale.push(file.id); // VPx alpha is never proxied
        continue;
      }
    }
    // An audio proxy skips the fit check (review n4): the LRU never evicts an
    // in-use audio proxy, so re-making one can't start a loop, and without it
    // the preview plays silence or a misread for that file.
    if (file.type !== "audio" && inUseBytes + ev.bytes > budget) {
      overBudget.push(file.id);
      continue;
    }
    inUseBytes += ev.bytes;
    remadeAt.set(file.id, now);
    started.push(file.id);
    logger.info({ tag: "proxy", op: "ensure_on_open", pieceId, fileId: file.id, fileType: file.type }, "proxy.ensure_on_open");
    // The record goes only once the re-make has COMPLETED (review n1): a quit
    // while it is queued leaves the row idle and the record in place, so the
    // next boot's open makes it again. A failed one leaves the row `failed`,
    // which a later pass forgets as stale.
    void regenerateProxy(file.id, file.pieceId).then((ok) => {
      if (!ok) return;
      try {
        const [row] = getDb().select({ proxyStatus: files.proxyStatus }).from(files).where(eq(files.id, file.id)).limit(1).all();
        if (row?.proxyStatus === "ready") forgetEvictedProxies([file.id]);
      } catch (err) {
        logger.warn({ tag: "proxy", op: "evicted_forget_failed", fileId: file.id, err: err instanceof Error ? err.message : String(err) }, "proxy.evicted_forget_failed");
      }
    });
  }
  if (stale.length > 0) forgetEvictedProxies(stale);

  const key = overBudget.slice().sort().join(",");
  if (overBudget.length === 0) {
    overBudgetLogged.delete(pieceId);
  } else if (overBudgetLogged.get(pieceId) !== key) {
    overBudgetLogged.set(pieceId, key);
    logger.warn(
      { tag: "proxy", op: "ensure_over_budget", pieceId, fileIds: overBudget, inUseBytes, budget },
      "proxy.ensure_over_budget: this piece's proxies don't fit the proxy budget; the evicted ones stay pending (the preview plays the originals)",
    );
  }
  return started;
}

/**
 * Start re-making the evicted proxies of `pieceId`'s files (see the module
 * comment). Resolves with the ids it started once they are STARTED, not
 * finished. Never throws.
 */
export function ensureProxiesForPiece(pieceId: string): Promise<string[]> {
  const running = passes.get(pieceId);
  if (running) return running;
  const p = pass(pieceId)
    .catch((err: unknown) => {
      logger.warn(
        { tag: "proxy", op: "ensure_on_open_failed", pieceId, err: err instanceof Error ? err.message : String(err) },
        "proxy.ensure_on_open.failed",
      );
      return [] as string[];
    })
    .finally(() => passes.delete(pieceId));
  passes.set(pieceId, p);
  return p;
}
