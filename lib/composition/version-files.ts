import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { CompositionManifest } from "./persistence";

export type RefKind = "scene" | "overlay" | "audio";

export interface FileRef {
  fileId: string;
  refKind: RefKind;
  /** Name of the referencing entity, for "Demo scene → file deleted" messaging. */
  refName: string;
}

/** Pure: collect every file the manifest depends on, with a human ref name. */
export function collectReferencedFileIds(manifest: CompositionManifest): FileRef[] {
  // Canvas scenes reference no file (video scenes, which did, were retired), so
  // every manifest file reference comes from an overlay or an audio clip.
  const refs: FileRef[] = [];
  for (const o of manifest.overlays ?? []) {
    if (o.kind === "image" || o.kind === "video") {
      refs.push({ fileId: o.fileId, refKind: "overlay", refName: `${o.kind} overlay` });
    } else if (o.kind === "tracked") {
      const c = o.content;
      if (c.kind === "image" || c.kind === "video") {
        refs.push({ fileId: c.fileId, refKind: "overlay", refName: "tracked overlay" });
      }
    }
  }
  for (const c of manifest.audioClips ?? []) {
    // An inline clip is bound to a video OVERLAY (`linkedOverlayId`).
    // `linkedSceneId` is the retired video-scene spelling, still resolved so a
    // legacy snapshot names its clips honestly rather than falling back.
    const linkedOverlay = c.linkedOverlayId
      ? (manifest.overlays ?? []).find((o) => o.id === c.linkedOverlayId)
      : undefined;
    const linkedScene = c.linkedSceneId
      ? (manifest.scenes ?? []).find((s) => s.id === c.linkedSceneId)
      : undefined;
    const linkedName = linkedOverlay?.displayName ?? linkedScene?.name;
    const name =
      c.label ??
      (linkedName
        ? `${linkedName} audio`
        : c.kind === "inline"
          ? "clip audio"
          : "audio clip");
    refs.push({ fileId: c.fileId, refKind: "audio", refName: name });
  }
  return refs;
}

/** Pure: keep only refs whose fileId is absent from `existing`. */
export function computeMissingRefs(refs: FileRef[], existing: Set<string>): FileRef[] {
  return refs.filter((r) => !existing.has(r.fileId));
}

/**
 * Detect manifest file references that point at deleted files.
 * Considers piece-scoped + global files. Returns one entry per missing
 * referencing entity (deduped on fileId+refKind+refName).
 */
export async function detectMissingFiles(
  manifest: CompositionManifest,
  pieceId: string,
): Promise<FileRef[]> {
  const refs = collectReferencedFileIds(manifest);
  if (refs.length === 0) return [];
  const db = getDb();
  const pieceFiles = db.select({ id: files.id }).from(files).where(eq(files.pieceId, pieceId)).all();
  const existing = new Set(pieceFiles.map((f) => f.id));
  // Referenced ids not in the piece set might be global — check those individually.
  for (const r of refs) {
    if (!existing.has(r.fileId)) {
      const [hit] = db.select({ id: files.id }).from(files).where(eq(files.id, r.fileId)).limit(1).all();
      if (hit) existing.add(hit.id);
    }
  }
  const missing = computeMissingRefs(refs, existing);
  const seen = new Set<string>();
  return missing.filter((r) => {
    const key = `${r.fileId}|${r.refKind}|${r.refName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
