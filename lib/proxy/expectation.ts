import type { FileRecord } from "@/lib/db/schema/types";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";

/** Whether a file has, will have, or can never have a proxy. */
export type ProxyExpectation = "none" | "pending" | "ready";

/**
 * Whether `file` has, will have, or can never have a proxy. It mirrors the
 * rules that decide whether one is made:
 * - videos get one; an audio file only when the preview can't play it
 *   itself (lib/ffmpeg/audio-preview.ts), once its job runs;
 * - VPx-alpha video never does (proxy_gen refuses it, `pickVideoUrl` serves
 *   the original);
 * - a failed job leaves none.
 * The preview's audio engine reads it so it never asks for a proxy that can't
 * exist, and asks again only when one lands (Re-review R4).
 */
export function proxyExpectation(
  file: Pick<FileRecord, "type" | "hasAlpha" | "proxyStatus" | "proxyFilename" | "filename" | "contentType"> | null | undefined,
): ProxyExpectation {
  if (!file) return "none";
  // An audio file has a proxy only when the preview can't play it itself
  // (lib/ffmpeg/audio-preview.ts): expected once its job runs, never before.
  if (file.type === "audio") {
    if (file.proxyStatus === "ready" && file.proxyFilename) return "ready";
    return file.proxyStatus === "generating" ? "pending" : "none";
  }
  if (file.type !== "video") return "none";
  if (alphaRecoverableInPreview({ hasAlpha: file.hasAlpha, filename: file.filename, contentType: file.contentType })) {
    return "none";
  }
  if (file.proxyStatus === "failed") return "none";
  if (file.proxyStatus === "ready" && file.proxyFilename) return "ready";
  return "pending";
}

type ExpectationRow = Parameters<typeof proxyExpectation>[0] & {
  id: string;
  proxyGeneratedAt?: Date | string | number | null;
};

/**
 * The proxy status of `fileId` for the preview's audio engine: its
 * expectation plus a revision, the proxy's generation time. A proxy
 * regenerated while its status stayed "ready" then reads as new
 * (final review F1).
 *
 * The file is looked up in the piece's files, then in the global library
 * (a global video used in a piece is in the second list only). A file in
 * neither is "unknown", which the engine tries once per play or seek
 * (final review F2).
 */
export function proxyStatusForFile(
  fileId: string,
  pieceFiles: readonly ExpectationRow[] | undefined,
  globalFiles: readonly ExpectationRow[] | undefined,
): { state: ProxyExpectation | "unknown"; revision: string | null } {
  const file = pieceFiles?.find((f) => f.id === fileId) ?? globalFiles?.find((f) => f.id === fileId);
  if (!file) return { state: "unknown", revision: null };
  const at = file.proxyGeneratedAt;
  const revision = at == null ? null : at instanceof Date ? at.toISOString() : String(at);
  return { state: proxyExpectation(file), revision };
}
