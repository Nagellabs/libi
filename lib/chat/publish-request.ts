/**
 * The chat half of `libi.publish_template`, which only PREPARES a publish.
 *
 * When its result says `awaiting_your_confirmation`, the in-app chat shows a
 * compact card — "Ready to publish ‹name›" with a "Review and publish" link to
 * that request's review panel on the Templates page, where only the user can
 * publish it. The tool chip stays beside it: the card adds the way forward,
 * it hides nothing. Pure helpers — no React, no server deps — mirroring
 * `lib/chat/provider-suggestion.ts`.
 */
import { fromAnyToolName, parseMcpToolId } from "@/lib/agents/mcp-tool-id";
import { unwrapToolResult } from "./chat-media";

/** Registered MCP tool name whose result can carry a publish request. */
export const PUBLISH_TEMPLATE_TOOL = "libi.publish_template";
/** The tool's status for a recorded request (mcp/tools/template-cloud-tools.ts#AWAITING_STATUS). */
const AWAITING = "awaiting_your_confirmation";
const LIBI_SERVER_ID = "libi";

export interface PublishRequestCardPayload {
  requestId: string;
  name: string;
}

type ToolCallLike = { rawTitle?: string | null; toolId?: string | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True when a tool call is `libi.publish_template` (canonical id first; the raw title only when there is none). */
export function isPublishTemplateCall(call: ToolCallLike): boolean {
  const id = call.toolId || (call.rawTitle ? fromAnyToolName(call.rawTitle) : null);
  const parsed = id ? parseMcpToolId(id) : null;
  return parsed?.serverId === LIBI_SERVER_ID && parsed.toolName === PUBLISH_TEMPLATE_TOOL;
}

/** The card for a publish_template call, or null: another tool, no result yet, an error, or a refusal. */
export function extractPublishRequest(call: ToolCallLike, result: { result?: unknown; success?: boolean } | undefined): PublishRequestCardPayload | null {
  if (!isPublishTemplateCall(call)) return null;
  if (!result || result.success === false) return null;
  if (isRecord(result.result) && result.result.isError === true) return null;
  const output = unwrapToolResult(result.result);
  if (!isRecord(output) || output.success === false) return null;
  const data = isRecord(output.data) ? output.data : output;
  if (data.status !== AWAITING || typeof data.requestId !== "string" || data.requestId.length === 0) return null;
  return { requestId: data.requestId, name: typeof data.name === "string" ? data.name : "" };
}

/** The review panel of that request, on the Templates page. */
export function publishReviewHref(p: PublishRequestCardPayload): string {
  return `/templates?tab=mine&review=${encodeURIComponent(p.requestId)}`;
}
