import { z } from "zod/v3";
import {
  downloadModel,
  clearModelDir,
} from "@/lib/music/generate";
import {
  isAceStepModelInstalled,
  missingAceStepModelFiles,
  writeInstalledToken,
  aceStepModelsDir,
  ACESTEP_MODEL_VERSION,
  ACESTEP_DOWNLOAD_BYTES,
} from "@/lib/music/models";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { trackDirectoryBytes } from "@/lib/jobs/dir-download-progress";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

/** Chat/Settings show `done`/`total` verbatim, so report MB rather than raw
 *  bytes — "4821/7892 MB" reads, "5053071360/8275792188 bytes" does not. Matches
 *  the unit `tts_model_download` already uses. */
const BYTES_PER_MB = 1_000_000;

// Empty on purpose: "install the ACE-Step model" is ONE piece of work with one
// output directory, so it must have exactly one paramsHash.
//
// This used to be `{ force: z.boolean().optional() }`, and that single field
// was the bug. `{force:true}` hashes differently from `{}`, so a retry never
// attached to the download already in flight — it created a SECOND job over
// the same directory, which then `clearModelDir()`'d ~5.3 GB the first job had
// already fetched (measured on the packaged app, 2026-08-02). Force is a
// restart POLICY, not a parameter of the work; it travels via `forceNew` on
// the enqueue options and arrives as `ctx.forced`.
const paramsSchema = z.object({});

export type MusicModelDownloadParams = z.infer<typeof paramsSchema>;

export interface MusicModelDownloadResult {
  alreadyInstalled: boolean;
}

export const musicModelDownloadRunner: JobRunner<
  MusicModelDownloadParams,
  MusicModelDownloadResult
> = {
  kind: "music_model_download",
  mcpToolId: makeMcpToolId("libi", "libi.music_download_model"),
  maxConcurrent: 1,
  paramsSchema,
  // The HF pull has no clean midpoint; restart on retry. The .part-style
  // atomicity is owned by ACE-Step's downloader.
  resumable: false,
  // One shared output dir (~/.libi/models/ace-step) for every run of this kind,
  // so a forced restart must not race one already in flight.
  exclusiveResource: true,
  // ~8.3 GB pull + wheel fetch runs silent for many minutes.
  noProgressTimeoutMs: null,
  async run(
    ctx: JobContext<MusicModelDownloadParams>,
  ): Promise<MusicModelDownloadResult> {
    const force = ctx.forced === true;
    const discard = ctx.discardOutput === true;
    if (!force && isAceStepModelInstalled()) {
      ctx.reportProgress(1, 1, "model");
      return { alreadyInstalled: true };
    }
    // ONLY an explicit user "re-download" wipes the dir — never a retry.
    //
    // This used to key on `ctx.forced`, which looked right and was not: every
    // retry surface sets `forceNew` (the failed-row auto-escape in
    // mcp/jobs-client.ts, and POST /api/jobs/[id]/retry), so the documented
    // "a plain retry resumes" branch below was unreachable in production and
    // every retry after a network blip discarded the partial pull. Verified
    // against git: before that coupling, a retry carried `{force:false}` in
    // params and did NOT clear. huggingface_hub's snapshot_download resumes
    // both completed files and `.incomplete` blobs, and both live under this
    // dir, so `rm -rf` throws away everything a retry could have reused.
    if (discard) clearModelDir();

    // Progress is measured in MEGABYTES ON DISK, not in files completed.
    //
    // The Python side (`snapshot_download`'s outer tqdm bar) only ticks once per
    // finished file, and this repo's 12 files run from 639 bytes to 6.61 GB. So
    // the old file-count progress sat at 11/12 for 24 silent minutes while the
    // transformer downloaded, and the ETA — extrapolated from how fast the tiny
    // config files landed — advertised about a minute for all of it
    // (session 9c3ce4d0, 2026-08-17). Bytes are what actually take the time.
    const totalMb = Math.max(1, Math.round(ACESTEP_DOWNLOAD_BYTES / BYTES_PER_MB));
    // NO opening `reportProgress(0, totalMb)` here, deliberately. It looks like
    // harmless initialisation and it cost 64 seconds of visible "0%" on a real
    // resumed download (measured 2026-08-17, 7.1 GB already on disk):
    //
    //   - the explicit 0 is simply FALSE on a resume — bytes are already there;
    //   - it consumes JobManager's 1s progress debounce, so the tracker's very
    //     first measurement (the resume baseline) is dropped as too-soon;
    //   - and the tracker only re-emits on an INCREASE, so that baseline is gone
    //     for good. The bar then reads 0/8276 until real bytes climb past what
    //     was already on disk — 64s here, and minutes on a cold `uv` cache,
    //     which is exactly the "is it stuck?" state this change exists to end.
    //
    // Letting the tracker's immediate measure be the first report costs nothing
    // (it is not debounced, since nothing preceded it) and starts the bar at the
    // truth: 7148/8276 MB for the resume above, 0 for a genuinely fresh install.
    const progress = trackDirectoryBytes({
      dir: aceStepModelsDir(),
      totalBytes: ACESTEP_DOWNLOAD_BYTES,
      onBytes: (bytesDone) => {
        ctx.reportProgress(
          Math.min(Math.floor(bytesDone / BYTES_PER_MB), totalMb),
          totalMb,
          "MB",
        );
      },
    });
    try {
      // The file-count callback no longer drives the bar — mixing units in one
      // job would corrupt the rolling ETA, which averages ms-per-unit. It still
      // earns its keep as a poke: a finished file is the moment the on-disk
      // total jumps, so measure right then instead of up to a poll later.
      await downloadModel(() => progress.poke());
    } finally {
      progress.stop();
    }
    if (ctx.shouldCancel()) throw new Error("cancelled");
    // VERIFY BEFORE DECLARING SUCCESS. `downloadModel` resolving means `uv`
    // exited 0, which is not the same as "the weights are on disk" — the dir
    // can be cleared underneath us, and a partial snapshot exits cleanly. Left
    // unchecked this wrote the install token and returned success over an empty
    // directory, so the job row read `completed` while the model was absent and
    // the failure only surfaced later as a confusing MODEL_LOAD_FAILED.
    const missing = missingAceStepModelFiles();
    if (missing.length > 0) {
      throw new Error(
        `ACE-Step download finished but ${missing.length} model file(s) are missing or empty: ` +
          `${missing.join(", ")}. The model is NOT installed; re-run with force to start over.`,
      );
    }
    // The version source of truth: write the dependency-manager-compatible
    // marker so resolveStatus + isAceStepModelInstalled() agree.
    writeInstalledToken(ACESTEP_MODEL_VERSION);
    if (!isAceStepModelInstalled()) {
      throw new Error(
        "ACE-Step install token was written but the model still reads as not installed",
      );
    }
    ctx.reportProgress(totalMb, totalMb, "MB");
    return { alreadyInstalled: false };
  },
};
