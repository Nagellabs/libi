/**
 * Shared helpers for rendering agent-created media inline in the chat.
 *
 * The `libi.show_in_chat` tool returns a `chatMedia` payload on its result;
 * the chat reduces the tool-call + result into an inline media card via these
 * pure helpers (no React, no server deps — usable from both the MCP tool and
 * the chat UI).
 */

/** Registered MCP tool name whose result carries an inline chat-media payload. */
export const SHOW_IN_CHAT_TOOL = "libi.show_in_chat";

export type ChatMediaKind = "image" | "video" | "audio" | "other";

export interface ChatMediaPayload {
  fileId: string;
  kind: ChatMediaKind;
  contentType: string | null;
  caption?: string;
  filename?: string;
}

const KINDS: readonly ChatMediaKind[] = ["image", "video", "audio", "other"];

/** Map a MIME type to a media kind. Unknown / missing → "other". */
export function classifyChatMedia(
  contentType: string | null | undefined,
): ChatMediaKind {
  if (!contentType) return "other";
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  return "other";
}

/** True when a tool identifier names the show_in_chat tool. Robust to every
 *  prefix form the chat may carry — `libi.show_in_chat`, `libi:show_in_chat`,
 *  the MCP-namespaced `mcp__libi__libi_show_in_chat`, or a bare
 *  `show_in_chat` — by matching the `show_in_chat` suffix at a delimiter
 *  boundary (`.`, `:`, `_`, or start). */
export function isShowInChatName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /(?:^|[._:])show_in_chat$/.test(name);
}

/** Unwrap the many shapes a tool result reaches the chat reducer as, to the
 *  plain tool-output object. MCP tools arrive as a content array
 *  (`[{type:"text",text}]` or `{content:[…]}`) whose text is the JSON-stringified
 *  output; non-MCP results may be a bare object or a JSON string. */
function unwrapToolResult(result: unknown): unknown {
  const items: unknown[] | null = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as Record<string, unknown>).content)
      ? ((result as Record<string, unknown>).content as unknown[])
      : null;
  if (items) {
    const text = items
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === "object" &&
          (c as Record<string, unknown>).type === "text" &&
          typeof (c as Record<string, unknown>).text === "string",
      )
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  return result;
}

/** Read a `chatMedia` payload off a show_in_chat tool result. Robust to the
 *  shape the chat reducer stores — an MCP content array, a bare object, or a
 *  JSON string — with the payload at the top level or under `data`. Returns
 *  null when absent / unparseable. */
export function readChatMedia(result: unknown): ChatMediaPayload | null {
  const obj = unwrapToolResult(result);
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  const data = (r.data ?? null) as Record<string, unknown> | null;
  const media = (r.chatMedia ?? data?.chatMedia) as
    | Record<string, unknown>
    | undefined;
  if (!media || typeof media !== "object") return null;
  if (typeof media.fileId !== "string") return null;

  const kind: ChatMediaKind = KINDS.includes(media.kind as ChatMediaKind)
    ? (media.kind as ChatMediaKind)
    : classifyChatMedia(
        typeof media.contentType === "string" ? media.contentType : null,
      );

  return {
    fileId: media.fileId,
    kind,
    contentType:
      typeof media.contentType === "string" ? media.contentType : null,
    ...(typeof media.caption === "string" ? { caption: media.caption } : {}),
    ...(typeof media.filename === "string"
      ? { filename: media.filename }
      : {}),
  };
}

/** Given a tool-call and its (optional) result, return the chat-media payload
 *  to render inline — only for the show_in_chat tool, only once the result has
 *  arrived. */
export function extractChatMedia(
  call: { rawTitle?: string | null; toolId?: string | null },
  result: { result?: unknown } | undefined,
): ChatMediaPayload | null {
  if (!isShowInChatName(call.toolId) && !isShowInChatName(call.rawTitle)) {
    return null;
  }
  if (!result) return null;
  return readChatMedia(result.result);
}

/** True when a tool-call is the show_in_chat presentation tool (its chip is
 *  suppressed in the chat — the media card replaces it). */
export function isShowInChatCall(call: {
  rawTitle?: string | null;
  toolId?: string | null;
}): boolean {
  return isShowInChatName(call.toolId) || isShowInChatName(call.rawTitle);
}
