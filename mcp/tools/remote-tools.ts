import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { runJobViaServer } from "@/mcp/jobs-client";
import type { ImportRemoteFilesParams } from "@/mcp/tools/schemas";
import type { RemoteFetchResult } from "@/lib/jobs/runners/remote-fetch";

export async function importRemoteFiles(
  params: ImportRemoteFilesParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<{ success: true; data: { items: RemoteFetchResult["items"] } }> {
  const resp = await runJobViaServer<RemoteFetchResult>(
    "remote_fetch",
    { urls: params.urls, pieceId: params.pieceId, autoUpload: params.autoUpload ?? true },
    { extra, pieceId: params.pieceId ?? undefined },
  );

  // `matching_completed` carries the cached result on `existingJob.result`;
  // all other shapes (`new`, `attached_running`, `new`+forced) carry it on `.result`.
  if (resp.status === "matching_completed") {
    // Don't reuse a terminal-failed/cancelled cached job — surface the error.
    if (resp.existingJob.status === "failed" || resp.existingJob.status === "cancelled") {
      throw new Error(resp.existingJob.error ?? `previous job ${resp.existingJob.status}`);
    }
    return { success: true, data: { items: resp.existingJob.result?.items ?? [] } };
  }

  return { success: true, data: { items: resp.result?.items ?? [] } };
}
