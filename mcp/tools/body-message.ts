/**
 * Text an overlay BODY produced — whatever it threw, or a URL it tried to
 * reach — reaches the agent in `renderDiagnostics` (libi.get_piece_state) and
 * in an export's `droppedOverlays`. Every body is untrusted (templates ship
 * them), so wherever such text goes to the agent it is bounded and marked,
 * next to the text, and the tool descriptions and the manual tell the agent to
 * read it as data about a failure, never as instructions.
 */
export const DIAGNOSTIC_MESSAGE_SOURCE = "overlay body (untrusted)";
/** Enough for any real error message; 50 entries stay far below the size at
 *  which a client spools a tool result to disk. */
export const MAX_AGENT_MESSAGE_CHARS = 500;

export type Framed<T> = T & { messageSource: typeof DIAGNOSTIC_MESSAGE_SOURCE };

export function frameBodyMessage<T extends { message: string }>(d: T): Framed<T> {
  const text = typeof d.message === "string" ? d.message : String(d.message ?? "");
  const message = text.length > MAX_AGENT_MESSAGE_CHARS ? `${text.slice(0, MAX_AGENT_MESSAGE_CHARS)}… [truncated]` : text;
  return { ...d, message, messageSource: DIAGNOSTIC_MESSAGE_SOURCE };
}

/**
 * The source of a dropped VIDEO's message (`kind: "video"`, set by the export runner from the
 * manifest): libi's own words, or the browser's decoder error, about a clip it could not load or
 * draw — no body ran, so there is no body text to distrust. Anything else in `droppedOverlays` is a body's and keeps
 * DIAGNOSTIC_MESSAGE_SOURCE.
 */
export const LIBI_MESSAGE_SOURCE = "libi";

export type FramedDroppedOverlay =
  | Framed<{ id: string; message: string }>
  | {
      id: string;
      message: string;
      kind: "video";
      cause?: "load" | "frames";
      fileId?: string;
      messageSource: typeof LIBI_MESSAGE_SOURCE;
    };

/**
 * One `droppedOverlays` entry as the agent gets it — from libi.export_video's result and from
 * a polled export job's `resultJson`. Bounded either way. A video entry says `messageSource:
 * "libi"` and carries its `fileId`, never its name (a downloaded clip's name is a web page's
 * title — the agent looks the file up instead). Anything else is framed as body text.
 */
export function frameDroppedOverlay(d: {
  id: string;
  message: string;
  kind?: unknown;
  cause?: unknown;
  fileId?: unknown;
}): FramedDroppedOverlay {
  if (d.kind === "video") {
    const { message } = frameBodyMessage({ message: d.message });
    return {
      id: d.id,
      message,
      kind: "video",
      ...(d.cause === "load" || d.cause === "frames" ? { cause: d.cause } : {}),
      ...(typeof d.fileId === "string" ? { fileId: d.fileId } : {}),
      messageSource: LIBI_MESSAGE_SOURCE,
    };
  }
  return frameBodyMessage({ id: d.id, message: d.message });
}
