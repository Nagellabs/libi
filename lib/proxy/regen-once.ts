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

type RegenOnceState = { inFlight: Map<string, Promise<boolean>>; regeneratedThisBoot: Set<string> };
/** Shared by EVERY copy of this module in the process: a production Next build loads the
 *  Category B sweeps and `GET /api/pieces/[pieceId]` (`lib/proxy/ensure.ts`) apart, and a
 *  regeneration one copy started was invisible to the other. (d2f3ea41's class.) */
const state = ((globalThis as Record<symbol, unknown>)[Symbol.for("libi.proxyRegenOnce.state")] ??= {
  inFlight: new Map<string, Promise<boolean>>(),
  regeneratedThisBoot: new Set<string>(),
}) as RegenOnceState;

/**
 * Regenerate `fileId`'s proxy through the normal `proxy_gen` job path and
 * resolve when it has finished: true when it succeeded.
 */
export function regenerateProxy(fileId: string, pieceId: string | null): Promise<boolean> {
  const running = state.inFlight.get(fileId);
  if (running) return running;
  state.regeneratedThisBoot.add(fileId);
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
    .finally(() => state.inFlight.delete(fileId));
  state.inFlight.set(fileId, done);
  return done;
}

/** Test hook: forget this "boot"'s regenerations. */
export function resetRegenOnceForTest(): void {
  state.inFlight.clear();
  state.regeneratedThisBoot.clear();
}

/** Whether a regeneration of `fileId` started by this module is in flight. */
export function regenerationInFlight(fileId: string): boolean {
  return state.inFlight.has(fileId);
}

/** Test hook: whether a regeneration of `fileId` is in flight. */
export function regenerationInFlightForTest(fileId: string): boolean {
  return regenerationInFlight(fileId);
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
    if (state.inFlight.has(row.id)) continue;
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
 *
 * `select` may instead answer `{ files, settled, incomplete }` (review I2 of
 * the audio-preview sweep): `settled` ids were checked and need nothing, and
 * go in the progress file so the next run's `select` can skip them (it is
 * handed the done set); `incomplete` means some file could not be judged
 * (a probe timed out), so the marker is NOT written and the sweep runs again
 * next boot for what is left.
 */
export type SweepSelection =
  | Array<{ id: string; pieceId: string | null }>
  | { files: Array<{ id: string; pieceId: string | null }>; settled?: string[]; incomplete?: boolean };

export async function runOnceSweep(
  marker: string,
  op: string,
  select: (done: ReadonlySet<string>) => Promise<SweepSelection>,
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
  const selection = await select(done);
  const picked = Array.isArray(selection) ? selection : selection.files;
  const settled = Array.isArray(selection) ? [] : (selection.settled ?? []);
  const incomplete = !Array.isArray(selection) && selection.incomplete === true;
  const todo = picked.filter((f) => !done.has(f.id) && !state.regeneratedThisBoot.has(f.id));
  fs.mkdirSync(stateDir, { recursive: true });
  const newlySettled = settled.filter((id) => !done.has(id));
  if (newlySettled.length > 0) fs.appendFileSync(progressPath, newlySettled.map((id) => `${id}\n`).join(""));
  let ok = 0;
  await Promise.all(
    todo.map(async (f) => {
      logger.info({ tag: "proxy", op, fileId: f.id, pieceId: f.pieceId }, `proxy.${op}`);
      if (await regenerateProxy(f.id, f.pieceId)) ok++;
      fs.appendFileSync(progressPath, `${f.id}\n`);
    }),
  );
  if (incomplete) {
    // Something couldn't be judged: no marker, and the progress file stays so
    // the next run skips what is already settled.
    logger.warn({ tag: "proxy", op: `${op}_incomplete`, regenerated: ok, failed: todo.length - ok }, `proxy.${op}.incomplete`);
    return;
  }
  fs.writeFileSync(markerPath, `${new Date().toISOString()} regenerated=${ok} failed=${todo.length - ok} earlier=${done.size}\n`);
  fs.rmSync(progressPath, { force: true });
  if (todo.length > 0) {
    logger.info({ tag: "proxy", op: `${op}_summary`, regenerated: ok, failed: todo.length - ok }, `proxy.${op}.summary`);
  }
}
