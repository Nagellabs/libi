// lib/jobs/runners/runtime-update.ts
//
// Download a newer published `@nagellabs/libi` and lay it down at
// `<LIBI_HOME>/runtime/<version>/`, ready for the next launch.
//
// ## Why this is a JobManager job
//
// It fetches ~775 packages plus a native prebuild: minutes, not seconds. That
// is CLAUDE.md's "Background Jobs" rule verbatim, and it buys three things the
// UI would otherwise have to hand-roll (which the same section explicitly
// forbids): a DB-backed status that survives a page reload or a server
// restart, dedupe by `(kind, paramsHash)` so a double-click cannot start two
// colliding npm installs into the same directory, and progress the Settings
// card can poll without a bespoke in-memory state machine.
//
// ## What it deliberately does NOT do
//
// It does not touch, restart, or hot-swap the running runtime. `installRuntime`
// builds into a temp directory and renames into place; the shell picks the new
// version up at next launch (`electron/runtime-loader.ts`). That is why the UI
// says "Restart Libi to finish updating" rather than implying a live upgrade —
// a claim that would be false the instant it was made.
import { z } from "zod/v3";

import { serverLogger as logger } from "@/lib/logger";
import { trackServerEvent } from "@/lib/analytics/server";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import {
  installRuntime,
  RuntimeInstallError,
  userRuntimeDir,
} from "@/lib/runtime/runtime-install";
import { resolveRegistryUrl, detectIsPackaged } from "@/lib/runtime/registry-url";
import { describeCurrentRuntime } from "@/lib/runtime/current-runtime";
import { pruneUserRuntimes, runningRuntimePrefix } from "@/lib/runtime/runtime-prune";

const LOG_TAG = "runtime-update";

/** Coarse phases, so the card can say something truthful while npm is silent. */
const TOTAL_STEPS = 3;

const runtimeUpdateParamsSchema = z.object({
  /** The published version to install. Part of the paramsHash — deliberate:
   *  re-requesting the SAME version attaches to the in-flight job, while a
   *  newer version is genuinely different work. */
  version: z.string().min(1),
});

export type RuntimeUpdateParams = z.infer<typeof runtimeUpdateParamsSchema>;

export interface RuntimeUpdateResult {
  version: string;
  prefix: string;
  shellApiVersion: number;
  /** Directories reclaimed by the post-install prune. Informational. */
  pruned: string[];
}

export const runtimeUpdateRunner: JobRunner<RuntimeUpdateParams, RuntimeUpdateResult> = {
  kind: "runtime_update",
  // One at a time, always: two concurrent installs would fight over
  // `<LIBI_HOME>/runtime/` and over npm's cache.
  maxConcurrent: 1,
  paramsSchema: runtimeUpdateParamsSchema,
  // npm install is not resumable in any meaningful way — `installRuntime`
  // builds into a fresh temp dir and a retry starts clean.
  resumable: false,
  // npm can run for many minutes without emitting anything we observe. The
  // watchdog would kill a perfectly healthy download.
  noProgressTimeoutMs: null,
  // Server-internal: triggered from Settings, not by an agent tool, so there
  // is no chat surface to route progress to (same posture as proxy_gen).
  async run(ctx: JobContext<RuntimeUpdateParams>): Promise<RuntimeUpdateResult> {
    const electronVersion = process.versions.electron;
    const isPackaged = detectIsPackaged();
    if (!electronVersion || !isPackaged) {
      // Belt and braces — the route refuses this too. A dev checkout has no
      // runtime snapshot to replace, and an `npx` install upgrades via npm.
      throw new Error(
        "in-app runtime updates are only available in the packaged desktop app",
      );
    }

    const current = describeCurrentRuntime();
    const registryUrl = resolveRegistryUrl({ isPackaged });
    let step = 0;
    ctx.reportProgress(step, TOTAL_STEPS, "steps");

    logger.info(
      {
        tag: LOG_TAG,
        op: "install_start",
        version: ctx.params.version,
        from: current.version,
        registryUrl,
      },
      "installing runtime update",
    );

    let installed;
    try {
      installed = await installRuntime({
        version: ctx.params.version,
        registryUrl,
        electronVersion,
        abi: process.versions.modules,
        onProgress: (message) => {
          step = Math.min(step + 1, TOTAL_STEPS - 1);
          ctx.reportProgress(step, TOTAL_STEPS, "steps");
          logger.info(
            { tag: LOG_TAG, op: "install_progress", message },
            "runtime update progress",
          );
        },
      });
    } catch (err) {
      // Surface the typed distinction the installer went to the trouble of
      // making (npm registry vs github.com for the native prebuild) — a user
      // behind a proxy can self-diagnose from it. `err.message` already names
      // the host; JobManager stores it on the row and the card shows it.
      if (err instanceof RuntimeInstallError) {
        logger.warn(
          { tag: LOG_TAG, op: "install_failed", kind: err.kind, host: err.host },
          err.message,
        );
      }
      throw err;
    }

    // Housekeeping — never allowed to fail the install that triggered it.
    let pruned: string[] = [];
    try {
      pruned = pruneUserRuntimes({
        protectPrefix: runningRuntimePrefix(),
        rootDir: userRuntimeDir(),
      }).removed;
    } catch (err) {
      logger.warn(
        { tag: LOG_TAG, op: "prune_error", err: (err as Error).message },
        "post-install prune failed (harmless)",
      );
    }

    ctx.reportProgress(TOTAL_STEPS, TOTAL_STEPS, "steps");
    logger.info(
      {
        tag: LOG_TAG,
        op: "install_done",
        version: installed.version,
        prefix: installed.prefix,
        prunedCount: pruned.length,
      },
      "runtime update installed — applies at next launch",
    );

    // Adoption signal. Bounded cardinality by construction: the ONLY param is
    // which kind of runtime the user was on before. Version strings are
    // deliberately absent — they are unbounded over the product's life, and
    // GA4 charges cardinality for every distinct value.
    void trackServerEvent("runtime_update_installed", {
      previous_source: current.source,
    });

    return {
      version: installed.version,
      prefix: installed.prefix,
      shellApiVersion: installed.shellApiVersion,
      pruned,
    };
  },
};
