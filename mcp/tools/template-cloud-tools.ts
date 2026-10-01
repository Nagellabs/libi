/**
 * `libi.publish_template` — PREPARE a publish; only the user publishes.
 *
 * The tool runs the local preflight a publish runs before its first network
 * call (the template's text and files against the catalog's rules, the
 * nickname's shape, the example source) for a quick refusal, then the server's
 * `template_publish_prepare` job (lib/jobs/runners/template-publish-prepare.ts,
 * reached over HTTP — nothing under mcp/ imports lib/jobs) makes the request's
 * own example video and poster and records a publish request
 * (lib/templates/cloud/publish-requests.ts). Nothing is uploaded. The
 * user reviews the request — exactly those files — on the Templates page and
 * publishes it there, or doesn't: the same for every agent, every approval
 * mode, the in-app chat and the user's own CLI.
 *
 * Publishing is invite-only (lib/templates/cloud/creator.ts): the creator's
 * status is asked first — the one call that leaves the machine, a read of this
 * install's approval — and an unapproved (or unknown) one is refused with
 * libi's words and no job. An unapproved one also carries
 * `code: "creator_not_approved"`, on which the Templates page re-reads its
 * cached approval.
 *
 * `confirm` is accepted and ignored: older copies of the templates skill send it.
 *
 * Nothing it returns is author-supplied text beyond the user's own template
 * name and public nickname, and it never returns the request's confirm code.
 * The nickname is returned so the agent can tell the user what it is: every
 * creator starts with a random default ("Brave Otter 4821") nobody asked them
 * for, which they may want to change before they publish.
 */
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types";
import { activeCatalogSource } from "@/lib/templates/cloud/catalog-setting";
import { withCatalogSource } from "@/lib/templates/cloud/catalog-source";
import { checkCreatorApproved } from "@/lib/templates/cloud/creator";
import { AWAITING_MESSAGE, checkPublishRequestable } from "@/lib/templates/cloud/publish-requests";
import { musicNotIncluded } from "@/lib/templates/music-links";
import { readScaffold } from "@/lib/templates/store";
import { mcpLogger as logger } from "@/lib/logger";
import { trackMcpEvent } from "@/mcp/analytics";
import { LibiServerUnavailableError, runJobViaServer } from "@/mcp/jobs-client";
import type { PublishTemplateParams } from "@/mcp/tools/schemas";

/** The one status a prepared publish answers with: the next step is the user's. */
export const AWAITING_STATUS = "awaiting_your_confirmation";

/** The prepare job's result. Declared here, not imported: nothing under mcp/ imports lib/jobs. */
interface PrepareJobResult {
  requestId: string;
  templateId: string;
  name: string;
  nickname?: string | null;
}

export type PublishTemplateOutcome =
  | {
      success: true;
      data: { status: typeof AWAITING_STATUS; requestId: string; templateId: string; name: string; nickname: string | null; message: string; nicknameNote?: string };
    }
  | { success: false; data: { error: string; code?: typeof CREATOR_NOT_APPROVED_CODE } };

/**
 * The refusal's code when the catalog said this creator isn't approved (none,
 * pending or rejected — not when it couldn't be asked): mcp/server.ts tells the
 * Templates page to re-read the approval then.
 */
export const CREATOR_NOT_APPROVED_CODE = "creator_not_approved";

/** What the agent tells the user about the nickname the publish goes out under. */
export function nicknameNote(nickname: string): string {
  return `It will be published under the public nickname "${nickname}" (libi's random default unless the user chose it). Tell the user that name, and that they can change it: under "Publishing as" on the Templates page, in Settings → General, or by asking you to prepare the publish again with another nickname.`;
}

const STOPPED = "The preparation was stopped before it finished, so nothing was prepared. Do not prepare it again unless the user asks.";

export async function publishTemplate(
  params: PublishTemplateParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<PublishTemplateOutcome> {
  // The catalog this call asks on: the gate, and the job — which prepares for it even if the user switches before it starts.
  const source = activeCatalogSource({ fresh: true });
  // Invite-only: an unapproved creator hears so before anything is checked or made.
  const gate = await withCatalogSource(source, () => checkCreatorApproved());
  if (!gate.ok) return { success: false, data: { error: gate.error, ...(gate.status !== "unknown" ? { code: CREATOR_NOT_APPROVED_CODE } : {}) } };
  const input = { templateId: params.templateId, exampleVideo: params.exampleVideo, ...(params.nickname !== undefined ? { nickname: params.nickname.trim() } : {}) };
  const checked = await checkPublishRequestable(input);
  if (!checked.ok) return { success: false, data: { error: checked.error } };
  let result: PrepareJobResult | undefined;
  try {
    // forceNew: every call prepares afresh from the source as it is NOW — never an earlier run's cached request.
    const r = await runJobViaServer<PrepareJobResult>("template_publish_prepare", { ...input, source }, {
      extra,
      forceNew: true,
      signal: extra?.signal,
      ...("exportPieceId" in params.exampleVideo ? { pieceId: params.exampleVideo.exportPieceId } : {}),
    });
    if (r.status === "matching_completed") {
      if (r.existingJob.status === "cancelled") return { success: false, data: { error: STOPPED } };
      if (r.existingJob.status !== "completed") return { success: false, data: { error: r.existingJob.error ?? "The publish couldn't be prepared." } };
      result = r.existingJob.result;
    } else {
      result = r.result;
    }
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) return { success: false, data: { error: `${err.message} ${err.hint}`.trim() } };
    // The jobs client's CancelledError, by name: nothing under mcp/ imports lib/jobs.
    if ((err instanceof Error && err.name === "CancelledError") || extra?.signal?.aborted) return { success: false, data: { error: STOPPED } };
    return { success: false, data: { error: err instanceof Error ? err.message : String(err) } };
  }
  if (!result?.requestId) return { success: false, data: { error: "The publish couldn't be prepared." } };
  trackMcpEvent("template_publish_requested");
  const nickname = result.nickname ?? null;
  // The songs the template names but does not carry (social-music spec §7):
  // the agent tells the user before they publish.
  const read = await readScaffold(result.templateId).catch((err: unknown) => {
    // The request is recorded either way; only the music note is lost.
    logger.warn(
      { tag: "templates", op: "music_links_read_failed", templateId: result.templateId, error: err instanceof Error ? err.message : String(err) },
      "could not read the template back for its music links",
    );
    return null;
  });
  const notIncluded = read?.ok ? musicNotIncluded(read.scaffold) : [];
  return {
    success: true,
    data: {
      status: AWAITING_STATUS,
      requestId: result.requestId,
      templateId: result.templateId,
      name: result.name,
      nickname,
      message: AWAITING_MESSAGE,
      ...(nickname ? { nicknameNote: nicknameNote(nickname) } : {}),
      ...(notIncluded.length
        ? {
            musicNotIncluded: notIncluded,
            musicNote: "These songs are named by the template but not included: tell the user; whoever applies it is asked before the song is downloaded.",
          }
        : {}),
    },
  };
}
