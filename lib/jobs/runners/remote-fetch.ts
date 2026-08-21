import { z } from "zod/v3";
import path from "node:path";
import fsAsync from "node:fs/promises";
import type { JobRunner, JobContext } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { assertPublicHttpUrl } from "@/lib/net/url-guard";
import { fetchAndStoreRemoteFile, fetchRemoteBuffer } from "@/lib/net/fetch-and-store";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";

// The download-and-store body this runner used to own now lives in
// `lib/net/fetch-and-store.ts` so the onboarding asset build shares the exact
// same guard, cap and storeFile call. Re-exported here because existing
// importers (and their tests) reach for them through this module.
export { readBodyWithCap, MAX_BYTES } from "@/lib/net/fetch-and-store";

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

/**
 * Basename of `url`'s path, or "" when there isn't one (`https://host/`) or
 * the url doesn't parse. Parse failures deliberately return "" rather than
 * throwing: the SSRF guard downstream produces the actionable `invalid url:`
 * message for those, and throwing here would replace it with a bare
 * `Invalid URL`.
 */
function urlBasename(url: string): string {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return "";
  }
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
      // The index makes this collision-free, which MATTERS on the
      // `autoUpload: false` branch below: it writes straight to a path with no
      // dedupe of any kind, so two basename-less urls in one batch sharing a
      // fallback name would have the second silently overwrite the first —
      // leaving the first item reporting a `localPath` and a `bytes` count for
      // bytes that are no longer there.
      const filename = urlBasename(url) || `download-${i}.bin`;

      // Per-URL isolation: one bad url must never fail the other nineteen.
      try {
        if (autoUpload) {
          // Urls here come from an agent/user, so the guard is always the
          // full SSRF one — re-applied to every redirect hop inside.
          const stored = await fetchAndStoreRemoteFile({
            url,
            guard: assertPublicHttpUrl,
            pieceId,
            filename,
          });
          items.push({
            url,
            status: "ok",
            fileId: stored.fileId,
            bytes: stored.bytes,
          });
        } else {
          const { buffer } = await fetchRemoteBuffer({
            url,
            guard: assertPublicHttpUrl,
            filename,
          });
          const dir = path.join(
            getLibiHome(),
            "tmp",
            "remote-fetch",
            ctx.jobId,
          );
          await fsAsync.mkdir(dir, { recursive: true });
          const dest = path.join(dir, filename);
          await fsAsync.writeFile(dest, buffer);
          items.push({
            url,
            status: "ok",
            localPath: dest,
            bytes: buffer.byteLength,
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
