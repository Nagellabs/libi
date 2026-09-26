import { z } from "zod/v3";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { JobRunner, JobContext } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { withAdapter } from "@/lib/social/service";
import { isAllowedExportPath } from "@/lib/social/fit-check";
import { SocialError } from "@/lib/social/errors";
import { serverLogger as logger } from "@/lib/logger";

const paramsSchema = z.object({
  providerId: z.literal("zernio"),
  exportPath: z.string().min(1),
  pieceId: z.string().min(1),
  /**
   * `exportFingerprint(exportPath)` — size + mtime of the bytes being
   * uploaded, so `(kind, paramsHash)` dedupe means "this FILE", not "this
   * path". Re-export the piece to the same path and the hash moves with it.
   * See the function's own note for why a timestamp belongs here.
   */
  fileFingerprint: z.string().min(1),
});
export type SocialUploadParams = z.infer<typeof paramsSchema>;
export interface SocialUploadResult {
  publicUrl: string;
  expiresAt: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * Presign at the provider (libi's grant), then PUT the export's bytes to the
 * storage URL — no Authorization header, the URL IS the credential and it
 * lives ~1 h. Runs here rather than in the MCP child so the agent's
 * `libi.post_piece` and the Posting tab share one path and one progress bar.
 */
export const socialUploadRunner: JobRunner<SocialUploadParams, SocialUploadResult> = {
  kind: "social-upload",
  maxConcurrent: 1,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<SocialUploadParams>,
  resumable: false,
  noProgressTimeoutMs: 120_000,
  mcpToolId: makeMcpToolId("libi", "libi.post_piece"),
  async run(ctx: JobContext<SocialUploadParams>): Promise<SocialUploadResult> {
    const { exportPath } = ctx.params;
    if (!isAllowedExportPath(exportPath)) throw new SocialError("validation", "that file is not one of your exports");
    const filename = path.basename(exportPath);
    const contentType = MIME[path.extname(exportPath).toLowerCase()] ?? "application/octet-stream";
    const sizeBytes = fs.statSync(exportPath).size;
    if (sizeBytes > 5 * 1024 ** 3) throw new SocialError("validation", "the provider caps uploads at 5 GB");

    // The presign call is the provider's grant; a refusal here is a distinct
    // failure kind (SocialError from withAdapter/the adapter) from a byte
    // upload failing below — never conflate the two in a caller-facing message.
    const presigned = await withAdapter((a) => a.presign({ filename, contentType, sizeBytes }));
    logger.info(
      { tag: "social", op: "upload.start", jobId: ctx.jobId, sizeBytes, contentType },
      "uploading export to provider storage",
    );

    let sent = 0;
    ctx.reportProgress(0, sizeBytes, "bytes");
    const stream = fs.createReadStream(exportPath, { highWaterMark: 1024 * 1024 });

    // JobManager cancels via ctx.shouldCancel(); an AbortController tied to
    // the PUT itself is what actually stops the network request. Checking
    // shouldCancel() only from the stream's "data" handler (as this used to)
    // leaves a gap: once the file has fully drained into the request — a
    // small file, or a fast disk ahead of a slow connection — no more "data"
    // events ever fire, so a cancellation landing after that point would be
    // recorded but never acted on, and the PUT would just sit there until the
    // provider eventually responds. The interval is the backstop for that
    // gap; the "data" handler still aborts immediately when a cancellation
    // lands mid-read, without waiting for the next tick.
    const ac = new AbortController();
    const cancelPoll = setInterval(() => {
      if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
    }, 500);
    // Aborting the fetch stops the request; destroying the source stream
    // releases the open file descriptor promptly rather than waiting for GC.
    ac.signal.addEventListener("abort", () => stream.destroy(new Error("cancelled")));
    stream.on("data", (chunk: string | Buffer) => {
      sent += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      ctx.reportProgress(sent, sizeBytes, "bytes");
      if (ctx.shouldCancel() && !ac.signal.aborted) ac.abort();
    });

    let res: Response;
    try {
      // No Authorization header, deliberately: libi holds no credential for
      // the storage host — the presigned URL itself is the bearer capability.
      // Never log `presigned.uploadUrl`.
      res = await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType, "content-length": String(sizeBytes) },
        body: Readable.toWeb(stream) as ReadableStream,
        duplex: "half",
        signal: ac.signal,
      } as RequestInit);
    } catch (err) {
      if (ac.signal.aborted) throw new Error("cancelled");
      const name = err instanceof Error ? err.name : typeof err;
      throw new SocialError("provider", `upload to storage failed (${name})`);
    } finally {
      clearInterval(cancelPoll);
    }
    if (ac.signal.aborted) throw new Error("cancelled");
    if (!res.ok) throw new SocialError("provider", `upload rejected by storage (${res.status})`, { status: res.status });

    ctx.reportProgress(sizeBytes, sizeBytes, "bytes");
    logger.info({ tag: "social", op: "upload.done", jobId: ctx.jobId, sizeBytes }, "export uploaded");
    return { publicUrl: presigned.publicUrl, expiresAt: presigned.expiresAt, sizeBytes, contentType, filename };
  },
};
