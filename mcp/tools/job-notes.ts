/**
 * What an agent should do with a job-backed tool's dedup answer, said in the
 * RESULT — where it applies — instead of in every tool's description, where it
 * cost ~2.4 KB of every `tools/list` across five tools whether or not a call
 * ever attached to a running job.
 *
 * Returned as `data.note` only when `attachedToRunning` / `matchedExisting` is
 * actually set. The descriptions keep one sentence about it (and the one thing
 * that cannot live in a result: an interrupted call never returns one).
 */

/** The `startedAt` pointer every attached note shares. */
const ELAPSED = "(`existingJob.startedAt` says when it began)";

/** A download/install tool attached to an identical job that was already running. */
export function attachedDownloadNote(opts: { what: string; restartArg: string }): string {
  return (
    `Attached to ${opts.what} that was already running and waited for it, so it is now on disk. ` +
    `Tell the user you joined an existing run ${ELAPSED} and ask whether they want a separate fresh one ` +
    `(${opts.restartArg}).`
  );
}

/** A download/install tool answered from a cached earlier job. */
export function matchedDownloadNote(opts: { restartArg: string }): string {
  return (
    "An earlier identical job matched; `status` is re-checked against what is on disk, so trust it. " +
    `If it says installed there is nothing to do; ${opts.restartArg} only if you suspect the files are corrupt.`
  );
}

/** generate_music attached to an identical generation that was already running. */
export const GENERATE_MUSIC_ATTACHED_NOTE =
  `Attached to an identical generation that was already running and waited for it: the audio file in this result is new. ` +
  `Tell the user you joined an existing run ${ELAPSED} and ask whether they want a separate fresh one (forceNew:true).`;

/**
 * generate_music was answered from a cached earlier result: NO audio file was
 * made (the earlier file is no longer guaranteed on disk). Replaces the
 * "dedup heuristic from CLAUDE.md" the description used to cite — libi writes
 * no CLAUDE.md, so the rule lives where the situation arises.
 */
export const GENERATE_MUSIC_MATCHED_NOTE =
  "A cached result from an earlier identical request matched, so NO new audio file was made. " +
  "To get audio, call again with forceNew:true. Retry silently when the earlier run was for another piece or is over 7 days old; " +
  "when it is this piece, recent and successful, ask the user whether to reuse that result or regenerate.";

/** install_tracking_engine attached to an install that was already running. */
export const INSTALL_ATTACHED_NOTE =
  "Attached to the tracking-engine install that was already running and waited for it, so the engine is now on disk. " +
  `Tell the user you joined an existing install ${ELAPSED}. To genuinely start over, libi.job({ action: "cancel", jobId }) first, then re-run with force:true.`;

/**
 * The ONE sentence the job-backed tools' descriptions keep about this. It
 * cannot move into a result: an interrupted or declined call never returns one.
 */
export const SERVER_JOB_DESCRIPTION =
  "A server job: if this call is interrupted or declined it KEEPS GOING — check `libi.job({ action: \"list\", status: \"running\" })` before telling the user nothing happened.";
