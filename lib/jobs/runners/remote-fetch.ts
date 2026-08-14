import { z } from "zod/v3";
import path from "node:path";
import fsAsync from "node:fs/promises";
import type { JobRunner, JobContext } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { assertPublicHttpUrl } from "@/lib/net/url-guard";
import { fetchFollowingVettedRedirects } from "@/lib/net/follow-redirects";
import { storeFile, mimeFromExtension } from "@/mcp/tools/file-tools";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";

const remoteFetchParamsSchema = z.object({
  urls: z.array(z.string()).min(1).max(20),
  pieceId: z.string().nullable(),
  autoUpload: z.boolean().default(true),
});

export type RemoteFetchParams = z.infer<typeof remoteFetchParamsSchema>;

export interface RemoteFetchItem {
  url: string;
  status: "ok" | "error";
  fileId?: string;
  localPath?: string;
  bytes?: number;
  error?: string;
}

export interface RemoteFetchResult {
  items: RemoteFetchItem[];
}

/** Maximum download size per file: 500 MB. */
const MAX_BYTES = 500 * 1024 * 1024;

/**
 * Read a fetch Response body into a Buffer, enforcing a hard byte cap AS the
 * stream arrives. A server that lies about (or omits) Content-Length can't make
 * us buffer an unbounded body — the moment the running counter exceeds the cap
 * we abort the in-flight download instead of reading it to completion.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body) {
    // No stream (empty body) — arrayBuffer is already bounded by the empty body.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`file too large: ${buf.byteLength} bytes (max ${maxBytes})`);
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        capped = true;
        throw new Error(`file too large: exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    // On a cap breach, cancel the underlying stream so the socket is freed and
    // the remote download is aborted rather than draining in the background.
    if (capped) void body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

export const remoteFetchRunner: JobRunner<RemoteFetchParams, RemoteFetchResult> = {
  kind: "remote_fetch",
  maxConcurrent: 3,
  paramsSchema: remoteFetchParamsSchema as unknown as z.ZodSchema<RemoteFetchParams>,
  resumable: true,
  noProgressTimeoutMs: 120_000,
  mcpToolId: makeMcpToolId("libi", "libi.import_remote_files"),

  async run(ctx: JobContext<RemoteFetchParams>): Promise<RemoteFetchResult> {
    const { urls, pieceId, autoUpload } = ctx.params;

    // Resume from checkpoint if available.
    const prior = (ctx.resumeState as RemoteFetchResult | null)?.items ?? [];
    const items: RemoteFetchItem[] = [...prior];
    ctx.reportProgress(items.length, urls.length, "files");

    for (let i = items.length; i < urls.length; i++) {
      if (ctx.shouldCancel()) throw new Error("cancelled");

      const url = urls[i];

      try {
        // SSRF guard, re-applied to EVERY hop of the redirect chain (not just
        // the start and the final `res.url`): resolves DNS and throws for
        // private/loopback/metadata addresses, including a hostname that
        // merely resolves to one, before that hop is ever dereferenced.
        const res = await fetchFollowingVettedRedirects(url, assertPublicHttpUrl, {
          signal: AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
          throw new Error(`http ${res.status}`);
        }

        // Cheap pre-check: reject obviously-too-large downloads from the
        // declared Content-Length before reading a single byte of the body.
        const declaredLen = Number(res.headers.get("content-length"));
        if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
          throw new Error(
            `file too large: ${declaredLen} bytes (max ${MAX_BYTES})`,
          );
        }

        // Stream the body with a running byte cap — the Content-Length check is
        // advisory (a server can lie or omit it), so the cap is enforced for
        // real as bytes arrive.
        const buf = await readBodyWithCap(res, MAX_BYTES);

        const filename =
          path.basename(new URL(url).pathname) || `download-${i}.bin`;
        const contentType =
          res.headers.get("content-type") ?? mimeFromExtension(filename);

        if (autoUpload) {
          const record = await storeFile({
            pieceId,
            filename,
            buffer: buf,
            contentType,
          });
          items.push({
            url,
            status: "ok",
            fileId: record.id,
            bytes: buf.byteLength,
          });
        } else {
          const dir = path.join(
            getLibiHome(),
            "tmp",
            "remote-fetch",
            ctx.jobId,
          );
          await fsAsync.mkdir(dir, { recursive: true });
          const dest = path.join(dir, filename);
          await fsAsync.writeFile(dest, buf);
          items.push({
            url,
            status: "ok",
            localPath: dest,
            bytes: buf.byteLength,
          });
        }
      } catch (err) {
        logger.warn(
          { tag: "remote-fetch", op: "url_error", url, jobId: ctx.jobId, err },
          "remote_fetch: url failed",
        );
        items.push({
          url,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await ctx.checkpoint({ items });
      ctx.reportProgress(items.length, urls.length, "files");
    }

    if (items.length > 0 && items.every((i) => i.status === "error")) {
      const first = items.find((i) => i.status === "error");
      throw new Error(
        `all ${items.length} downloads failed: ${first && "error" in first ? first.error : "unknown"}`,
      );
    }
    return { items };
  },
};
