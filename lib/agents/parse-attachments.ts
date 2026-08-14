/**
 * Parser for the `[Attached files]` block that `/api/agent/send` appends
 * to user-message text when a chat message includes file attachments.
 *
 * On the LIVE path the chat UI synthesizes proper `file-attachment`
 * parts client-side (see use-agent-chat.ts:sendMessage) — but on
 * `loadSession` REPLAY the agent only re-emits the raw user-message
 * text, which still contains the inline block. Without this parser the
 * page-refresh case would lose the structured attachment parts and
 * render thumbnails as plain text.
 *
 * Format produced by `formatAttachments` in app/api/agent/send/route.ts:
 *
 *     \n\n[Attached files]\n
 *     - {filename} ({contentType?, sizeStr[, WxH][, durationS]}) — fileId: {id}
 *     - ...
 *
 * The em-dash `—` (U+2014) is a literal sentinel in the format and
 * gives us a stable suffix to anchor on regardless of whether the
 * filename contains parens.
 */
import type { AgentMessagePart } from "./message-types";

export interface ParsedAttachment {
  fileId: string;
  filename: string;
  contentType: string | null;
  size: number;
}

// `formatAttachments` writes the block as `\n\n[Attached files]\n…` but
// upstream cleaners (slash-command stripper, trimStart) may eat the
// leading newlines, so we anchor on the header line itself. The match
// captures any preceding whitespace so we can splice it out cleanly.
const BLOCK_HEADER_RE = /(?:^|\n)\s*\[Attached files\]\n/;
const FILEID_SUFFIX = " — fileId: ";

/** Convert a humanized size like "8.0 MB" back to bytes. Best-effort —
 *  the chip prefers the live `useFileById` record when available, so an
 *  imprecise fallback here only matters when the file has been deleted.
 *  Returns 0 when the format is unrecognized. */
function parseSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor =
    unit === "B" ? 1 :
    unit === "KB" ? 1024 :
    unit === "MB" ? 1024 ** 2 :
    unit === "GB" ? 1024 ** 3 :
    unit === "TB" ? 1024 ** 4 : 1;
  return Math.round(n * factor);
}

/** Parse one attachment line. Returns null if the line doesn't match. */
function parseLine(line: string): ParsedAttachment | null {
  if (!line.startsWith("- ")) return null;
  const sepIdx = line.lastIndexOf(FILEID_SUFFIX);
  if (sepIdx === -1) return null;
  const fileId = line.slice(sepIdx + FILEID_SUFFIX.length).trim();
  if (!fileId) return null;
  const beforeId = line.slice(2, sepIdx); // strip "- " prefix
  // beforeId looks like: "name (metadata)" — find the LAST `(` so
  // filenames containing parens still parse. Metadata never contains
  // parens (only commas separating contentType, size, dimensions, duration).
  const openParen = beforeId.lastIndexOf(" (");
  if (openParen === -1 || !beforeId.endsWith(")")) {
    return { fileId, filename: beforeId, contentType: null, size: 0 };
  }
  const filename = beforeId.slice(0, openParen);
  const meta = beforeId.slice(openParen + 2, -1); // strip ` (` and `)`
  const fields = meta.split(", ");

  let contentType: string | null = null;
  let size = 0;
  for (const f of fields) {
    if (f.includes("/") && !contentType) contentType = f;
    else if (/^[\d.]+\s*(B|KB|MB|GB|TB)$/i.test(f)) size = parseSize(f);
    // dimensions and duration are derivable from the live file record
    // when present, so we drop them here rather than re-parsing.
  }

  return { fileId, filename, contentType, size };
}

/**
 * Pull the `[Attached files]` block out of a user-message text and
 * return the cleaned text plus the parsed attachment list. If the block
 * is absent, returns the original text and an empty array.
 *
 * Trailing/leading whitespace introduced by the splice is normalized so
 * a message that was just "see file.jpg\n\n[Attached files]\n…" doesn't
 * end up with dangling blank lines.
 */
export function extractAttachmentsBlock(text: string): {
  text: string;
  attachments: ParsedAttachment[];
} {
  const match = BLOCK_HEADER_RE.exec(text);
  if (!match) return { text, attachments: [] };

  const before = text.slice(0, match.index);
  const blockBody = text.slice(match.index + match[0].length);

  const lines = blockBody.split("\n");
  const attachments: ParsedAttachment[] = [];
  let trailingStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (parsed) {
      attachments.push(parsed);
    } else {
      // First non-attachment line ends the block — anything after it
      // belongs to the user's continued text (rare but possible if a
      // future change appends more after the block).
      trailingStart = i;
      break;
    }
  }

  // No attachments parsed at all — the header was present but the block
  // body didn't match. Leave the text untouched rather than mangle it.
  if (attachments.length === 0) {
    return { text, attachments: [] };
  }

  const trailing =
    trailingStart === -1 ? "" : lines.slice(trailingStart).join("\n");
  const cleaned = (before + (trailing ? "\n" + trailing : "")).trimEnd();

  return { text: cleaned, attachments };
}

/**
 * Apply `extractAttachmentsBlock` to every text part in a user message,
 * mutating it to add `file-attachment` parts and trim the inline block.
 * Idempotent — if no block is found the message is left alone.
 */
export function applyAttachmentParsing(
  parts: AgentMessagePart[],
): AgentMessagePart[] {
  let didExtract = false;
  const collected: ParsedAttachment[] = [];
  const next: AgentMessagePart[] = [];

  for (const part of parts) {
    if (part.type !== "text") {
      next.push(part);
      continue;
    }
    const { text, attachments } = extractAttachmentsBlock(part.text);
    if (attachments.length > 0) {
      didExtract = true;
      collected.push(...attachments);
      if (text.length > 0) {
        next.push({ type: "text", text });
      }
    } else {
      next.push(part);
    }
  }

  if (!didExtract) return parts;

  for (const a of collected) {
    next.push({
      type: "file-attachment",
      fileId: a.fileId,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    });
  }
  return next;
}
