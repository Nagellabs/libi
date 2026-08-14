// app/api/runtime/update/route.ts
//
// GET  — "is there an update, and what is the state of any install?"  Never
//        errors on a network failure; an unreachable registry is reported as
//        `state: "unknown"` and the UI stays quiet. Covers BOTH channels:
//        the npm runtime (update-check.ts) and the desktop shell's own
//        electron-updater feed (`shell`, when the shell registered one).
// POST — start an install. `target: "runtime"` (default) enqueues the
//        `runtime_update` JobManager job — nothing touches the RUNNING
//        runtime, the new one applies at next launch. `target: "shell"`
//        asks the shell's updater to download; the shell restarts itself
//        into the new version once the download is verified.
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

export async function GET(req: Request): Promise<Response> {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const current = describeCurrentRuntime();
  const update = await checkForRuntimeUpdate({ force, current });

  // "Check again" re-checks BOTH channels. The shell check is one HTTP GET
  // against the releases feed; awaiting it means the response the recheck
  // mutation stores already carries the fresh answer.
  const shellUpdater = getShellUpdater();
  if (force && shellUpdater) await shellUpdater.checkNow();

  const dto: RuntimeUpdateDto = {
    current: {
      version: current.version,
      source: current.source,
      shellApiVersion: current.shellApiVersion,
    },
    shellApi: current.shellApi,
    update,
    pendingVersion: current.updatesSupported
      ? pendingRuntimeVersion(current.version)
      : null,
    install: current.updatesSupported ? latestInstallJob() : null,
    shell: shellUpdater?.getStatus() ?? null,
  };
  return NextResponse.json(dto);
}

const postBodySchema = z.object({
  /** Must match the version the check advertised — see the 409 below. */
  version: z.string().min(1),
  /** Which channel to install from. Defaults to the npm runtime. */
  target: z.enum(["runtime", "shell"]).optional(),
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

  const manager = getJobManager();
  const first = await manager.enqueue(RUNTIME_UPDATE_JOB_KIND, {
    version: body.version,
  });
  // `matching_completed` means a previous attempt at this exact version already
  // finished — succeeded or failed. The user is asking again, so run it again
  // rather than replaying an old row's outcome as if it were this click's.
  // (That branch is also the only one of the four with no top-level `jobId`.)
  const result =
    first.status === "matching_completed"
      ? await manager.enqueue(
          RUNTIME_UPDATE_JOB_KIND,
          { version: body.version },
          { forceNew: true },
        )
      : first;
  const jobId = "jobId" in result ? result.jobId : result.existingJob.jobId;

  // Fire and forget: this takes minutes. The client polls GET.
  void manager.runToCompletion(jobId).catch((err: unknown) => {
    logger.warn(
      { tag: LOG_TAG, op: "run_failed", jobId, err: String(err) },
      "runtime update job ended in failure",
    );
  });

  logger.info(
    { tag: LOG_TAG, op: "install_enqueued", jobId, version: body.version },
    "runtime update enqueued",
  );
  return NextResponse.json({ jobId, version: body.version });
}
