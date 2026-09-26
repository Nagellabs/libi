import fs from "node:fs";
import path from "node:path";
import { getJobManager } from "@/lib/jobs/manager";
import { canonicalHash } from "@/lib/jobs/canonical-hash";
import { findRunningByHash } from "@/lib/jobs/repo";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiHome } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";

/**
 * The one-time proxy sweeps' shared regeneration path (regen-mkv-streams.ts,
 * regen-stream-lead.ts). Review round 3 (R3-M3) found two gaps:
 *
 * - **A quit mid-queue lost the regeneration.** The sweeps wrote their marker
 *   as soon as they had enqueued, while `proxy_gen` runs two at a time. On the
 *   next boot `recoverOrphanedJobs` marks every job left queued or running as
 *   failed, and the marker stopped the sweep from trying again. Queued is not
 *   durable here: only finished is. So a sweep now waits for each
 *   regeneration to finish, records every finished file in a progress file,
 *   and writes its marker last. A sweep cut short runs again on the next boot
 *   and skips the files it already did.
 * - **Two writers on one proxy.** A file in both sweeps was enqueued twice
 *   with `forceNew`, and `proxy_gen` writes straight to the live proxy file.
 *   Now one regeneration per file runs at a time in this process: a second
 *   request for the same file shares the first one's, and one that finds
 *   another caller's `proxy_gen` job for the file already queued or running
 *   waits for it before starting its own.
 *
 * **Next.js process only** (uses the in-process JobManager).
 */

const inFlight = new Map<string, Promise<boolean>>();
/** Files whose proxy this process has regenerated (or is regenerating) since boot. */
const regeneratedThisBoot = new Set<string>();

/**
 * Regenerate `fileId`'s proxy through the normal `proxy_gen` job path and
 * resolve when it has finished: true when it succeeded.
 */
export function regenerateProxy(fileId: string, pieceId: string | null): Promise<boolean> {
  const running = inFlight.get(fileId);
  if (running) return running;
  regeneratedThisBoot.add(fileId);
  const done = (async () => {
    const mgr = getJobManager();
    const live = await findRunningByHash("proxy_gen", canonicalHash({ fileId }));
    if (live) await mgr.runToCompletion(live.id).catch(() => undefined);
    const job = await mgr.enqueue("proxy_gen", { fileId }, { pieceId: pieceId ?? undefined, fileId, forceNew: true });
    if (job.status === "matching_completed") return true;
    await mgr.runToCompletion(job.jobId);
    return true;
  })()
    .catch((err: unknown) => {
      logger.warn(
        { tag: "proxy", op: "sweep_regen_failed", fileId, err: err instanceof Error ? err.message : String(err) },
        "proxy.sweep_regen.failed",
      );
      return false;
    })
    .finally(() => inFlight.delete(fileId));
  inFlight.set(fileId, done);
  return done;
}

/** Test hook: forget this "boot"'s regenerations. */
export function resetRegenOnceForTest(): void {
  inFlight.clear();
  regeneratedThisBoot.clear();
}

/** Test hook: whether a regeneration of `fileId` is in flight. */
export function regenerationInFlightForTest(fileId: string): boolean {
  return inFlight.has(fileId);
}

/**
 * Every boot: a proxy left at `generating` with no live `proxy_gen` job is
 * regenerated (review round 4, M-b). proxy_gen sets `generating` and writes
 * over the live proxy file, so a quit mid-run left a row the preview waited
 * on as "pending" forever, and a sweep resumed after the quit skipped it (it
 * selects `ready` rows). `recoverOrphanedJobs` runs earlier in boot and marks
 * the job failed, so a `generating` row here with no live job is stuck.
 *
 * Resolves once every stuck file's regeneration has STARTED (so a sweep run
 * after it shares, and never repeats, them); `done` resolves when they have
 * finished.
 */
export async function sweepStaleGeneratingProxies(
  rows?: Array<{ id: string; pieceId: string | null }>,
): Promise<{ started: number; done: Promise<unknown> }> {
  const candidates =
    rows ??
    getDb()
      .select({ id: files.id, pieceId: files.pieceId })
      .from(files)
      .where(eq(files.proxyStatus, "generating"))
      .all();
  const started: Promise<boolean>[] = [];
  for (const row of candidates) {
    if (inFlight.has(row.id)) continue;
    if (await findRunningByHash("proxy_gen", canonicalHash({ fileId: row.id }))) continue;
    logger.info({ tag: "proxy", op: "stale_generating_regen", fileId: row.id, pieceId: row.pieceId }, "proxy.stale_generating_regen");
    started.push(regenerateProxy(row.id, row.pieceId));
  }
  return { started: started.length, done: Promise.all(started) };
}

/**
 * Run a one-time sweep: regenerate every file `select` names that the sweep
 * hasn't already done, then write `marker` under `LIBI_HOME/state`. Files
 * finished are appended to `<marker>.progress` as they finish, so a sweep
 * interrupted by a quit resumes where it stopped. A regeneration that fails
 * (ffmpeg refused the file) counts as done: retrying it every boot wouldn't
 * change the answer. Nothing to do when the marker exists.
 */
export async function runOnceSweep(
  marker: string,
  op: string,
  select: () => Promise<Array<{ id: string; pieceId: string | null }>>,
): Promise<void> {
  const stateDir = path.join(getLibiHome(), "state");
  const markerPath = path.join(stateDir, marker);
  if (fs.existsSync(markerPath)) return;
  const progressPath = `${markerPath}.progress`;
  const done = new Set<string>();
  try {
    for (const line of fs.readFileSync(progressPath, "utf8").split("\n")) if (line) done.add(line);
  } catch {
    // no progress yet
  }
  // A file this process already regenerated since boot (the stale-generating
  // recovery, another sweep) is done: regenerating it again would change nothing.
  const todo = (await select()).filter((f) => !done.has(f.id) && !regeneratedThisBoot.has(f.id));
  fs.mkdirSync(stateDir, { recursive: true });
  let ok = 0;
  await Promise.all(
    todo.map(async (f) => {
      logger.info({ tag: "proxy", op, fileId: f.id, pieceId: f.pieceId }, `proxy.${op}`);
      if (await regenerateProxy(f.id, f.pieceId)) ok++;
      fs.appendFileSync(progressPath, `${f.id}\n`);
    }),
  );
  fs.writeFileSync(markerPath, `${new Date().toISOString()} regenerated=${ok} failed=${todo.length - ok} earlier=${done.size}\n`);
  fs.rmSync(progressPath, { force: true });
  if (todo.length > 0) {
    logger.info({ tag: "proxy", op: `${op}_summary`, regenerated: ok, failed: todo.length - ok }, `proxy.${op}.summary`);
  }
}
