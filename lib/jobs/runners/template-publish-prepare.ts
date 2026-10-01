/**
 * `template_publish_prepare` — `libi.publish_template`'s work: PREPARE a
 * publish for the user to review. Nothing leaves the machine and nothing is
 * published; only the user publishes, from the Templates page
 * (lib/templates/cloud/publish-confirm.ts).
 *
 *   1. the local preflight (`checkPublishRequestable`), again — the tool ran it
 *      once for a quick refusal, and the template may have changed since;
 *   2. the example source → the request's OWN example.mp4 and poster.jpg
 *      (lib/templates/cloud/publish-request-media.ts): a path or a piece file
 *      is transcoded as it is now, a piece is exported through the `export`
 *      job first; a copyrighted song never reaches the public example (a
 *      copyrighted file or an unrecorded path is transcoded without audio);
 *   3. the request is recorded, bound to the template's content and those two
 *      files' bytes (`recordPublishRequest`).
 *
 * The review shows exactly those files, and the `template_publish` job sends
 * exactly them — so what the user saw is what goes public, whatever happens
 * to the source (the piece, the file, the path) afterwards.
 *
 * A job because an export or a transcode takes more than a few seconds
 * (AGENTS.md → Long-running work): progress, cancellation. The MCP child
 * reaches it over HTTP (mcp/jobs-client.ts), never directly. Starting it
 * through `POST /api/jobs` publishes nothing either.
 */
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod/v3";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import { isCopyrighted } from "@/lib/audio-rights/read";
import { doneExportForPath } from "@/lib/exports/store";
import { CancelledError, type JobContext, type JobRunner } from "@/lib/jobs/types";
import { serverLogger as logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { NICKNAME_PATTERN } from "@/lib/templates/cloud/constants";
import { exportPieceForExample } from "@/lib/templates/example-export";
import { EXAMPLE_FILE, POSTER_FILE, preparingDir } from "@/lib/templates/cloud/publish-request-media";
import { makePoster, transcodeExample } from "@/lib/templates/cloud/publish-media";
import { checkPublishRequestable, recordPublishRequest } from "@/lib/templates/cloud/publish-requests";
import { catalogForQueuedJob, withCatalogSource } from "@/lib/templates/cloud/catalog-source";

const TAG = "templates-cloud";
const MUSIC_TAG = "social-music";
const CANCEL_POLL_MS = 500;

const paramsSchema = z
  .object({
    templateId: z.string().min(1),
    exampleVideo: z.union([
      z.object({ fileId: z.string().min(1) }).strict(),
      z.object({ path: z.string().min(1) }).strict(),
      z.object({ exportPieceId: z.string().min(1) }).strict(),
    ]),
    /** Mirrors the site's nickname rule (libi-site lib/templates/constants.ts#NICKNAME_PATTERN), trimmed. */
    nickname: z.string().trim().regex(NICKNAME_PATTERN, "nickname: 2–32 letters, digits, spaces, - or _").optional(),
    /** The catalog the tool asked on (`activeCatalogSource()` at enqueue): stable, so it may key the job. Absent on a job queued before it was a param. */
    source: z.string().min(1).optional(),
  })
  .strict();
export type TemplatePublishPrepareParams = z.infer<typeof paramsSchema>;

export interface TemplatePublishPrepareResult {
  requestId: string;
  templateId: string;
  name: string;
  /** The public nickname the publish goes out under (the one passed, else the stored default or chosen one). */
  nickname: string | null;
}

function checkCancel(ctx: JobContext<TemplatePublishPrepareParams>): void {
  if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
}

/** The example's source video, as it is now, and whether its audio may go public. */
interface ExampleSource {
  path: string;
  /** Transcode without audio: the source may carry a copyrighted song. */
  dropAudio: boolean;
}

/**
 * Whether the file at `file` is an export libi recorded as carrying no
 * copyrighted audio: its `piece_exports` record (the newest done one for that
 * path) says `carries_copyrighted = false`. Anything else — a with-song
 * export, a file libi never exported — may carry a song.
 */
async function recordedSongFree(file: string): Promise<boolean> {
  const row = await doneExportForPath(file);
  return row !== null && !row.carriesCopyrighted;
}

/**
 * The example's source. A published example is public, so a copyrighted
 * song never reaches it (social-music spec §7): a piece file
 * whose audio is copyrighted, or a path that is not a recorded song-free
 * export, is transcoded without audio. A piece is exported the social way
 * (`exportPieceForExample`), which already leaves any copyrighted song out.
 */
async function resolveSource(ctx: JobContext<TemplatePublishPrepareParams>, work: string, signal: AbortSignal): Promise<ExampleSource> {
  const ev = ctx.params.exampleVideo;
  if ("path" in ev) {
    const st = await fsp.stat(ev.path).catch(() => null);
    if (!path.isAbsolute(ev.path) || !st?.isFile()) throw new Error(`example video not found: ${ev.path}`);
    const dropAudio = !(await recordedSongFree(ev.path));
    if (dropAudio) {
      logger.info(
        { tag: MUSIC_TAG, op: "template_example_audio_dropped", templateId: ctx.params.templateId, path: path.basename(ev.path) },
        "template example transcoded without audio: the path is not an export recorded without copyrighted music",
      );
    }
    return { path: ev.path, dropAudio };
  }
  if ("fileId" in ev) {
    const [row] = getDb().select().from(filesTable).where(eq(filesTable.id, ev.fileId)).limit(1).all();
    if (!row) throw new Error(`file not found: ${ev.fileId}`);
    const dropAudio = isCopyrighted(row);
    if (dropAudio) {
      logger.info(
        { tag: MUSIC_TAG, op: "template_example_audio_dropped", templateId: ctx.params.templateId, fileId: ev.fileId },
        "template example transcoded without audio: the file's audio is copyrighted",
      );
    }
    // The ORIGINAL, never `proxyFilename`: a proxy is a scrub stand-in, not an output.
    return { path: (await getStorage()).localPath(row.pieceId, row.filename), dropAudio };
  }
  return { path: await exportPieceForExample(ctx as JobContext<unknown>, ev.exportPieceId, path.join(work, "export"), signal, 5, 60), dropAudio: false };
}

export const templatePublishPrepareRunner: JobRunner<TemplatePublishPrepareParams, TemplatePublishPrepareResult> = {
  kind: "template_publish_prepare",
  // ffmpeg, and possibly an export: one preparation at a time.
  maxConcurrent: 1,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<TemplatePublishPrepareParams>,
  // A restart prepares nothing half-way: the preparation folder is swept, and the agent prepares again.
  resumable: false,
  // The same preparation asked twice attaches to the run in flight.
  exclusiveResource: true,
  noProgressTimeoutMs: 180_000,
  mcpToolId: makeMcpToolId("libi", "libi.publish_template"),
  // Pinned to the catalog it was QUEUED on (a dev build can switch catalogs in
  // Settings before it starts): the request it records belongs to that catalog.
  async run(ctx) {
    const pinned = catalogForQueuedJob(ctx.params.source);
    if (!pinned.ok) throw new Error(pinned.error);
    return withCatalogSource(pinned.source, () => prepare(ctx));
  },
};

async function prepare(ctx: JobContext<TemplatePublishPrepareParams>): Promise<TemplatePublishPrepareResult> {
  const { templateId, exampleVideo, nickname } = ctx.params;
  const input = { templateId, exampleVideo, ...(nickname !== undefined ? { nickname } : {}) };
  const checked = await checkPublishRequestable(input);
  if (!checked.ok) throw new Error(checked.error);
  ctx.reportProgress(2, 100, "%");

  const requestId = randomUUID();
  const work = preparingDir(requestId);
  await fsp.mkdir(work, { recursive: true });
  const abort = new AbortController();
  const cancelPoll = setInterval(() => {
    if (ctx.shouldCancel() && !abort.signal.aborted) abort.abort();
  }, CANCEL_POLL_MS);
  try {
    const { path: source, dropAudio } = await resolveSource(ctx, work, abort.signal);
    checkCancel(ctx);
    ctx.reportProgress(60, 100, "%");
    try {
      await transcodeExample(source, path.join(work, EXAMPLE_FILE), {
        signal: abort.signal,
        onProgress: (r) => ctx.reportProgress(60 + Math.round(r * 30), 100, "%"),
        dropAudio,
      });
      await makePoster(source, path.join(work, POSTER_FILE), { signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) throw new CancelledError(ctx.jobId);
      throw err;
    }
    // Only the two files belong to the request.
    await fsp.rm(path.join(work, "export"), { recursive: true, force: true });
    checkCancel(ctx);
    ctx.reportProgress(95, 100, "%");
    const recorded = await recordPublishRequest({ id: requestId, ...input });
    if (!recorded.ok) throw new Error(recorded.error);
    ctx.reportProgress(100, 100, "%");
    logger.info({ tag: TAG, op: "publish_request_prepared", templateId, requestId, source: Object.keys(exampleVideo)[0] }, "publish prepared for the user to review");
    return { requestId, templateId, name: recorded.request.name, nickname: recorded.request.nickname };
  } finally {
    clearInterval(cancelPoll);
    // Recorded: the folder was moved into place, and this is a no-op. Otherwise nothing of this run stays.
    await fsp.rm(work, { recursive: true, force: true });
  }
}
