// app/api/runtime/update/route.ts
//
// GET  — "is there an update, and what is the state of any install?"  Never
//        errors on a network failure; an unreachable registry is reported as
//        `state: "unknown"` and the UI stays quiet. Covers BOTH channels:
//        the npm runtime (update-check.ts) and the desktop shell's own
//        electron-updater feed (`shell`, when the shell registered one).
//
//        GET also carries the AUTO-DOWNLOAD side effect: a check that
//        classifies `update-available` enqueues the download itself, once
//        per version per server process. The user is never asked to approve
//        a download — only the restart that applies it. (Packaged app only;
//        dev and npx never even check.)
// POST — the manual paths. `target: "runtime"` (default) re-enqueues the
//        `runtime_update` job — Settings' "Try again" after a failed
//        auto-download. `target: "shell"` relays a click to the shell's
//        updater: `action: "restart"` applies a ready download now;
//        `action: "install"` (default, and the only action old runtime UIs
//        send) starts a download on shells that don't auto-download.
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z, ZodError } from "zod/v3";

import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { getJobManager } from "@/lib/jobs/manager";
import { snapshotFromRow, type JobStatusSnapshot } from "@/lib/jobs/types";
import { serverLogger as logger } from "@/lib/logger";
import { describeCurrentRuntime } from "@/lib/runtime/current-runtime";
import { pendingRuntimeVersion } from "@/lib/runtime/installed-runtimes";
import { getShellUpdater, type ShellUpdateStatus } from "@/lib/runtime/shell-update";
import { checkForRuntimeUpdate, type UpdateStatus } from "@/lib/runtime/update-check";

const LOG_TAG = "runtime-update";
export const RUNTIME_UPDATE_JOB_KIND = "runtime_update";

export interface RuntimeUpdateDto {
  current: {
    version: string | null;
    source: string;
    shellApiVersion: number | null;
    /** What the desktop app ships, whether or not it is what is running. */
    bundledVersion: string | null;
  };
  shellApi: { min: number; max: number } | null;
  update: UpdateStatus;
  /** Downloaded and waiting for a restart, or null. */
  pendingVersion: string | null;
  /** Most recent install attempt, or null. Drives progress + failure copy. */
  install: (JobStatusSnapshot & { version: string | null }) | null;
  /**
   * The desktop shell's OWN update channel (electron-updater → GitHub
   * Releases), or null when there isn't one — a dev tree, an `npx` install,
   * or a shell that predates the updater. See lib/runtime/shell-update.ts.
   */
  shell: ShellUpdateStatus | null;
}

/** Latest `runtime_update` row, with the version pulled out of its params. */
function latestInstallJob(): (JobStatusSnapshot & { version: string | null }) | null {
  try {
    const db = getDb();
    const [row] = db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, RUNTIME_UPDATE_JOB_KIND))
      .orderBy(desc(jobs.createdAt))
      .limit(1)
      .all();
    if (!row) return null;
    let version: string | null = null;
    try {
      const params = JSON.parse(row.paramsJson) as { version?: unknown };
      if (typeof params.version === "string") version = params.version;
    } catch {
      /* a row we cannot parse still has a useful status */
    }
    return { ...snapshotFromRow(row), version };
  } catch (err) {
    // A degraded DB (libi has a documented migration-failed mode) must not
    // take out the version display or the update check.
    logger.warn(
      { tag: LOG_TAG, op: "install_job_read_failed", err: (err as Error).message },
      "could not read the latest runtime_update job",
    );
    return null;
  }
}

/**
 * Enqueue the `runtime_update` job for `version` and run it detached.
 * `matching_completed` means a previous attempt at this exact version
 * already finished — succeeded or failed. Both callers want a fresh run in
 * that case (the user clicked Try again, or a new process is auto-retrying
 * a download that failed last launch) rather than an old row's outcome
 * replayed as if it were this attempt's.
 */
async function enqueueRuntimeInstall(version: string): Promise<string> {
  const manager = getJobManager();
  const first = await manager.enqueue(RUNTIME_UPDATE_JOB_KIND, { version });
  const result =
    first.status === "matching_completed"
      ? await manager.enqueue(RUNTIME_UPDATE_JOB_KIND, { version }, { forceNew: true })
      : first;
  const jobId = "jobId" in result ? result.jobId : result.existingJob.jobId;

  // Fire and forget: this takes minutes. The client polls GET.
  void manager.runToCompletion(jobId).catch((err: unknown) => {
    logger.warn(
      { tag: LOG_TAG, op: "run_failed", jobId, err: String(err) },
      "runtime update job ended in failure",
    );
  });
  return jobId;
}

/**
 * Versions this process has already auto-started a download for. One shot
 * per version per launch: a download that failed is not retried in a loop —
 * Settings' "Try again" (POST) retries on demand, and the next app launch
 * gets one fresh attempt.
 */
const autoDownloadAttempted = new Set<string>();

export async function GET(req: Request): Promise<Response> {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const current = describeCurrentRuntime();
  const update = await checkForRuntimeUpdate({ force, current });

  // "Check again" re-checks BOTH channels. The shell check is one HTTP GET
  // against the releases feed; awaiting it means the response the recheck
  // mutation stores already carries the fresh answer.
  const shellUpdater = getShellUpdater();
  if (force && shellUpdater) await shellUpdater.checkNow();

  const pendingVersion = current.updatesSupported
    ? pendingRuntimeVersion(current.version)
    : null;
  let install = current.updatesSupported ? latestInstallJob() : null;

  // ── Auto-download ─────────────────────────────────────────────────────
  // The check just said an installable update exists; start fetching it.
  // The version comes from the server's OWN check (same trust stance as
  // POST's re-check), and `update-available` already excludes anything the
  // shell couldn't run. Skipped when that exact version is staged, when an
  // install is already in flight, and after one attempt per process.
  if (
    current.updatesSupported &&
    update.state === "update-available" &&
    update.latestVersion &&
    pendingVersion !== update.latestVersion &&
    !(install && (install.status === "queued" || install.status === "running")) &&
    !autoDownloadAttempted.has(update.latestVersion)
  ) {
    autoDownloadAttempted.add(update.latestVersion);
    try {
      const jobId = await enqueueRuntimeInstall(update.latestVersion);
      logger.info(
        { tag: LOG_TAG, op: "auto_install_enqueued", jobId, version: update.latestVersion },
        "runtime update found — downloading automatically",
      );
      // Reflect the download this response just started, so the client's
      // first poll already renders "downloading" instead of a stale offer.
      install = latestInstallJob();
    } catch (err) {
      logger.warn(
        { tag: LOG_TAG, op: "auto_install_failed", version: update.latestVersion, err: String(err) },
        "auto-download could not be enqueued",
      );
    }
  }

  const dto: RuntimeUpdateDto = {
    current: {
      version: current.version,
      source: current.source,
      shellApiVersion: current.shellApiVersion,
      bundledVersion: current.bundledVersion,
    },
    shellApi: current.shellApi,
    update,
    pendingVersion,
    install,
    shell: shellUpdater?.getStatus() ?? null,
  };
  return NextResponse.json(dto);
}

const postBodySchema = z.object({
  /** Must match the version the check advertised — see the 409 below. */
  version: z.string().min(1),
  /** Which channel to install from. Defaults to the npm runtime. */
  target: z.enum(["runtime", "shell"]).optional(),
  /**
   * Shell channel only. "restart" applies a READY download now; "install"
   * (default) starts a download — the only action old runtime UIs send.
   */
  action: z.enum(["install", "restart"]).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: z.infer<typeof postBodySchema>;
  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof ZodError ? err.errors[0]?.message : "invalid body";
    return NextResponse.json({ error: message ?? "invalid body" }, { status: 400 });
  }

  if (body.target === "shell") {
    // The shell downloads its own update and restarts itself into it — the
    // runtime's only job is to relay the click. Same trust model as the
    // runtime path: re-check against the FEED's answer rather than the
    // client's, since this click downloads and installs executable code.
    const updater = getShellUpdater();
    if (!updater) {
      return NextResponse.json(
        { error: "unsupported", message: "This install has no desktop-shell update channel." },
        { status: 400 },
      );
    }
    if (body.action === "restart") {
      // Apply a download that already landed. No feed re-check: this is not
      // a download decision, and the ready state was verified on disk by
      // electron-updater. The version must still match what's staged.
      const status = updater.getStatus();
      if (status.phase !== "ready" || status.latestVersion !== body.version) {
        return NextResponse.json(
          {
            error: "not-ready",
            message:
              `Refusing to restart into shell ${body.version}: the updater reports ` +
              `${status.latestVersion ?? "no version"} (${status.phase}).`,
            shell: status,
          },
          { status: 409 },
        );
      }
      // Old shells have no restart(); their download() restarts a ready
      // download itself, so the fallback keeps the same meaning.
      (updater.restart ?? updater.download).call(updater);
      logger.info(
        { tag: LOG_TAG, op: "shell_restart_requested", version: body.version },
        "shell update restart requested",
      );
      return NextResponse.json({ version: body.version, target: "shell", action: "restart" });
    }

    await updater.checkNow();
    const status = updater.getStatus();
    const offered =
      (status.phase === "update-available" || status.phase === "downloading" || status.phase === "ready") &&
      status.latestVersion === body.version;
    if (!offered) {
      return NextResponse.json(
        {
          error: "not-installable",
          message:
            `Refusing to install shell ${body.version}: the feed currently reports ` +
            `${status.latestVersion ?? "no newer version"} (${status.phase}).`,
          shell: status,
        },
        { status: 409 },
      );
    }
    updater.download();
    logger.info(
      { tag: LOG_TAG, op: "shell_install_requested", version: body.version },
      "shell update download requested",
    );
    return NextResponse.json({ version: body.version, target: "shell" });
  }

  const current = describeCurrentRuntime();
  if (!current.updatesSupported) {
    return NextResponse.json(
      {
        error: "unsupported",
        message:
          "In-app updates are only available in the packaged desktop app. " +
          "A dev checkout is its own runtime; an npx install upgrades with npm.",
      },
      { status: 400 },
    );
  }

  // Re-check rather than trusting the client. The compatible/incompatible
  // decision gates DOWNLOADING AND INSTALLING EXECUTABLE CODE, so the version
  // that gets installed must be one the server itself just classified as
  // installable — not one a stale tab (or anything else posting to loopback)
  // named. `force` is deliberate: the cached answer may predate a yank.
  const status = await checkForRuntimeUpdate({ force: true, current });
  if (status.state !== "update-available" || status.latestVersion !== body.version) {
    return NextResponse.json(
      {
        error: "not-installable",
        message:
          `Refusing to install ${body.version}: the registry currently reports ` +
          `${status.latestVersion ?? "no newer version"} (${status.state}).`,
        update: status,
      },
      { status: 409 },
    );
  }

  const jobId = await enqueueRuntimeInstall(body.version);

  logger.info(
    { tag: LOG_TAG, op: "install_enqueued", jobId, version: body.version },
    "runtime update enqueued",
  );
  return NextResponse.json({ jobId, version: body.version });
}
