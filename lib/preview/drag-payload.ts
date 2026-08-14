export const LIBI_FILE_MIME = "application/x-libi-file";
export interface FileDragPayload { fileId: string; contentType: string }
export function encodeFileDrag(p: FileDragPayload): string { return JSON.stringify(p); }
export function decodeFileDrag(raw: string): FileDragPayload | null {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.fileId === "string" && typeof o.contentType === "string") {
      return { fileId: o.fileId, contentType: o.contentType };
    }
  } catch { /* fall through */ }
  return null;
}
