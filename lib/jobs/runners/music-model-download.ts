import { z } from "zod/v3";
import {
  downloadModel,
  clearModelDir,
} from "@/lib/music/generate";
import {
  isAceStepModelInstalled,
  missingAceStepModelFiles,
  writeInstalledToken,
  ACESTEP_MODEL_VERSION,
} from "@/lib/music/models";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

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
  // ~5.5 GB pull + wheel fetch runs silent for many minutes.
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
    ctx.reportProgress(0, 1, "files");
    let lastTotal = 1;
    await downloadModel((done, total) => {
      if (total > 0) lastTotal = total;
      ctx.reportProgress(done, total > 0 ? total : 1, "files");
    });
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
    ctx.reportProgress(lastTotal, lastTotal, "files");
    return { alreadyInstalled: false };
  },
};
