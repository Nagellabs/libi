/**
 * The chat half of `libi.suggest_provider`.
 *
 * In-app, the tool answers with `status: "card"` and a list of suggestions;
 * the chat hides the tool chip and renders a card with one button per
 * suggestion in its place. These are the pure helpers behind that — no React,
 * no server deps — mirroring `lib/chat/chat-media.ts` for `libi.show_in_chat`.
 */

import type { AgentsTab } from "@/components/agents-page/use-agents-page-params";
import { fromAnyToolName, parseMcpToolId } from "@/lib/agents/mcp-tool-id";
import { unwrapToolResult } from "./chat-media";

/** Registered MCP tool name whose in-app result is a provider card. */
export const SUGGEST_PROVIDER_TOOL = "libi.suggest_provider";

/** Bundled server id libi's own tools canonicalize to (the in-app entry name
 *  and its fallback alias both resolve here in `mcp-tool-id.ts`). */
const LIBI_SERVER_ID = "libi";

const PROVIDERS_TAB: AgentsTab = "providers";
const LIBI_MCP_TAB: AgentsTab = "libi-mcp";

export interface ProviderSuggestion {
  id: string;
  name: string;
  kinds: string[];
  /** "remote-mcp" = the user connects it to their own agent; "extension" = libi's own, on-device. */
  kind: "remote-mcp" | "extension";
  /** extension only — the libi MCP tab's card id. */
  extensionId?: string;
  /** extension only — download size, shown on the button. */
  sizeNote?: string;
}

export interface ProviderSuggestionPayload {
  kind: string;
  suggested: ProviderSuggestion[];
  covered: Array<{ id: string; name: string; via: "connected" | "extension" }>;
}

type ToolCallLike = { rawTitle?: string | null; toolId?: string | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * True when a tool call is `libi.suggest_provider`.
 *
 * The canonical `toolId` decides whenever the call has one — for codex it
 * comes from the structured `rawInput.server` / `.tool` (`toolIdForCall`), and
 * the title beside it is presentation. Only a call with no id (a replayed part,
 * a label-only update) falls back to canonicalizing the raw title, through the
 * same helper the ingest path uses rather than by pattern-matching it here.
 */
export function isSuggestProviderCall(call: ToolCallLike): boolean {
  const id = call.toolId || (call.rawTitle ? fromAnyToolName(call.rawTitle) : null);
  const parsed = id ? parseMcpToolId(id) : null;
  return parsed?.serverId === LIBI_SERVER_ID && parsed.toolName === SUGGEST_PROVIDER_TOOL;
}

function readSuggestion(v: unknown): ProviderSuggestion[] {
  if (!isRecord(v) || !nonEmptyString(v.id) || !nonEmptyString(v.name)) return [];
  if (v.kind !== "remote-mcp" && v.kind !== "extension") return [];
  return [
    {
      id: v.id,
      name: v.name,
      kinds: Array.isArray(v.kinds) ? v.kinds.filter((k): k is string => typeof k === "string") : [],
      kind: v.kind,
      ...(nonEmptyString(v.extensionId) ? { extensionId: v.extensionId } : {}),
      ...(nonEmptyString(v.sizeNote) ? { sizeNote: v.sizeNote } : {}),
    },
  ];
}

function readCovered(v: unknown): ProviderSuggestionPayload["covered"] {
  if (!isRecord(v) || !nonEmptyString(v.id) || !nonEmptyString(v.name)) return [];
  if (v.via !== "connected" && v.via !== "extension") return [];
  return [{ id: v.id, name: v.name, via: v.via }];
}

/**
 * The card payload for a `suggest_provider` call, or null when there is no
 * card to draw: a different tool, no result yet, an errored result, or any
 * status other than `"card"` (`"none"` offers nothing; `"cli"` never reaches a
 * chat). Robust to the shapes the chat reducer stores — an MCP content array,
 * a bare object or a JSON string, with the output at the top level or under
 * `data`. Only the fields the card renders are kept.
 */
export function extractProviderSuggestion(
  call: ToolCallLike,
  result: { result?: unknown; success?: boolean } | undefined,
): ProviderSuggestionPayload | null {
  if (!isSuggestProviderCall(call)) return null;
  if (!result || result.success === false) return null;
  // Errors are hidden exactly like show_in_chat's: the agent's own reply
  // carries the failure, so the chat draws neither chip nor card.
  if (isRecord(result.result) && result.result.isError === true) return null;

  const output = unwrapToolResult(result.result);
  if (!isRecord(output) || output.success === false || output.isError === true) return null;
  const data = isRecord(output.data) ? output.data : output;
  if (data.status !== "card" || !nonEmptyString(data.kind) || !Array.isArray(data.suggested)) return null;

  const suggested = data.suggested.flatMap(readSuggestion);
  if (suggested.length === 0) return null;
  return {
    kind: data.kind,
    suggested,
    covered: Array.isArray(data.covered) ? data.covered.flatMap(readCovered) : [],
  };
}

/**
 * Where a suggestion's button goes: an on-device extension to its card on the
 * libi MCP tab, anything else to its row on the Providers tab. `from` names the
 * chat so the destination can offer Back to chat.
 */
export function suggestionHref(s: ProviderSuggestion, sessionId: string | null): string {
  const base =
    s.kind === "extension"
      ? `/agents?tab=${LIBI_MCP_TAB}&extension=${encodeURIComponent(s.extensionId ?? s.id)}`
      : `/agents?tab=${PROVIDERS_TAB}&provider=${encodeURIComponent(s.id)}`;
  return sessionId ? `${base}&from=${encodeURIComponent(sessionId)}` : base;
}
