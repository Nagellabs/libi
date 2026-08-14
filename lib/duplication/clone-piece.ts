import crypto from "node:crypto";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  pieces, files, assetFolders,
  analysisSteps, analysisKeyframes, analysisAudioChunks,
  characterAssets, itemAssets, jobs,
} from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot, saveCurrentSnapshot } from "@/lib/composition/snapshots";
import { getAnalysisDir } from "@/lib/analysis/storage";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import { rewriteFileIds } from "./rewrite-file-ids";
import { serverLogger as logger } from "@/lib/logger";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";

export type DuplicationSource = "draft" | "snapshot";

/**
 * Fully clone the contents of `sourcePieceId` into the already-created shell
 * piece `newPieceId`. Copies file bytes + proxies, the asset-folder tree, files
 * rows (with folderId remapped into the cloned tree), the manifest (with fileIds
 * rewritten), analysis rows + dirs, and catalog links.
 * On any error, rolls back (deletes the shell piece + its storage) and
 * re-throws — no partial piece survives.
 */
export async function clonePieceInto(
  sourcePieceId: string,
  newPieceId: string,
  source: DuplicationSource,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const db = getDb();
  const log = logger.child({ tag: "duplication", op: "clone_piece" });
  try {
    const src = db.select().from(pieces).where(eq(pieces.id, sourcePieceId)).get();
    if (!src) throw new Error(`source piece not found: ${sourcePieceId}`);

    const srcFiles = db.select().from(files).where(eq(files.pieceId, sourcePieceId)).all();
    const srcFolders = db.select().from(assetFolders).where(eq(assetFolders.pieceId, sourcePieceId)).all();

    const fileIdMap = new Map<string, string>();
    for (const f of srcFiles) fileIdMap.set(f.id, crypto.randomUUID());

    const storage = await getStorage();
    const total = srcFiles.length;
    let done = 0;

    // 1. asset folders — two-pass insert. Folders self-reference via
    //    parentFolderId, so insert every folder flat (parentFolderId=null) first
    //    to build oldId→newId, then fix up parent links in a second pass.
    const folderIdMap = new Map<string, string>();
    for (const fo of srcFolders) {
      const [row] = db.insert(assetFolders).values({
        pieceId: newPieceId,
        name: fo.name,
        parentFolderId: null, // set in second pass once all folders exist
      }).returning().all();
      folderIdMap.set(fo.id, row.id);
    }
    for (const fo of srcFolders) {
      if (!fo.parentFolderId) continue;
      const newParentId = folderIdMap.get(fo.parentFolderId);
      if (!newParentId) continue;
      db.update(assetFolders)
        .set({ parentFolderId: newParentId })
        .where(eq(assetFolders.id, folderIdMap.get(fo.id)!))
        .run();
    }

    // 2. files rows + byte copies
    for (const f of srcFiles) {
      const newId = fileIdMap.get(f.id)!;
      // copy original bytes
      if (await storage.exists(sourcePieceId, f.filename)) {
        const buf = await storage.read(sourcePieceId, f.filename);
        await storage.save(newPieceId, f.filename, buf, f.contentType ?? undefined);
      }
      // Copy proxy if present — but NEVER for a VPx-alpha row: any proxy on
      // such a row predates alpha-awareness and is alpha-stripped (H.264
      // yuv420p has no alpha plane, and alphamerge keeps the original RGB
      // planes intact — the "proxy" IS the original video, background and
      // all). The clone starts proxy-less and idle; pickVideoUrl serves its
      // original bytes and the proxy_gen runner refuses VPx-alpha rows
      // anyway. A NON-VPx alpha row (ProRes 4444, qtrle, ...) keeps carrying
      // its opaque proxy — it is the only thing that previews at all, and
      // exports read the ORIGINAL regardless.
      const carryProxy = !alphaRecoverableInPreview({
        hasAlpha: f.hasAlpha,
        filename: f.filename,
        contentType: f.contentType,
      });
      if (carryProxy && f.proxyFilename && (await storage.exists(sourcePieceId, f.proxyFilename))) {
        const pbuf = await storage.read(sourcePieceId, f.proxyFilename);
        await storage.save(newPieceId, f.proxyFilename, pbuf);
      }
      db.insert(files).values({
        id: newId,
        pieceId: newPieceId,
        folderId: f.folderId ? folderIdMap.get(f.folderId) ?? null : null,
        filename: f.filename,
        name: f.name,
        description: f.description,
        type: f.type,
        storagePath: `${newPieceId}/${f.filename}`,
        contentType: f.contentType,
        size: f.size,
        mediaDuration: f.mediaDuration,
        mediaWidth: f.mediaWidth,
        mediaHeight: f.mediaHeight,
        hasAudio: f.hasAudio,
        // hasAlpha is load-bearing: dropping it lands the cloned cutout as
        // NULL, which every consumer reads as OPAQUE — the cutout would export
        // as an opaque rectangle and a later rename would regenerate an
        // alpha-stripping proxy (the original B1 defect, reintroduced).
        hasAlpha: f.hasAlpha,
        proxyFilename: carryProxy ? f.proxyFilename : null,
        proxyStatus: carryProxy ? f.proxyStatus : "idle",
        proxyGeneratedAt: carryProxy ? f.proxyGeneratedAt : null,
        falUploadedUrl: null,
      }).run();
      done++;
      onProgress?.(done, total);

      // 3. analysis rows + dir for this file
      cloneAnalysisForFile(db, f.id, newId, newPieceId);
      const srcDir = getAnalysisDir(sourcePieceId, f.id);
      if (fs.existsSync(srcDir)) {
        fs.cpSync(srcDir, getAnalysisDir(newPieceId, newId), { recursive: true });
      }

      // 4. catalog links for this file
      for (const ca of db.select().from(characterAssets).where(eq(characterAssets.fileId, f.id)).all()) {
        db.insert(characterAssets).values({ characterId: ca.characterId, fileId: newId }).run();
      }
      for (const ia of db.select().from(itemAssets).where(eq(itemAssets.fileId, f.id)).all()) {
        db.insert(itemAssets).values({ itemId: ia.itemId, fileId: newId }).run();
      }
    }

    // 5. manifest — load chosen view, rewrite fileIds, write draft + snapshot
    const manifest =
      source === "snapshot"
        ? (await loadCurrentSnapshot(sourcePieceId)) ?? (await loadManifest(sourcePieceId))
        : await loadManifest(sourcePieceId);
    const rewritten = rewriteFileIds(manifest, fileIdMap) as typeof manifest;
    await saveManifest(newPieceId, rewritten);
    await saveCurrentSnapshot(newPieceId, rewritten);
    // saveManifest flips hasDraft=true; the copy starts committed.
    db.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, newPieceId)).run();

    log.info({ sourcePieceId, newPieceId, fileCount: total }, "duplication.clone.done");
  } catch (err) {
    log.error({ err, sourcePieceId, newPieceId }, "duplication.clone.failed_rollback");
    try {
      // Detach the piece_dup job(s) from the shell piece BEFORE deleting it.
      // `jobs.pieceId` has ON DELETE CASCADE → deleting the shell would also
      // delete the job row, leaving JobManager unable to mark it `failed` and
      // the agent's `get_job_status` poll returning a confusing 404/500. The
      // job must survive as a `failed`, retryable row.
      db.update(jobs).set({ pieceId: null }).where(eq(jobs.pieceId, newPieceId)).run();
    } catch (detachErr) {
      log.error({ err: detachErr, newPieceId }, "duplication.clone.job_detach_failed");
    }
    try {
      await deletePieceCompletely(newPieceId);
    } catch (rbErr) {
      log.error({ err: rbErr, newPieceId }, "duplication.clone.rollback_failed");
    }
    throw err;
  }
}

/** Copy a file's analysis_steps / keyframes / audio_chunks rows, remapping ids. */
function cloneAnalysisForFile(
  db: ReturnType<typeof getDb>,
  oldFileId: string,
  newFileId: string,
  newPieceId: string,
): void {
  const steps = db.select().from(analysisSteps).where(eq(analysisSteps.fileId, oldFileId)).all();
  const stepIdMap = new Map<string, string>();
  for (const s of steps) {
    const newStepId = crypto.randomUUID();
    stepIdMap.set(s.id, newStepId);
    db.insert(analysisSteps).values({
      id: newStepId, fileId: newFileId, pieceId: newPieceId,
      kind: s.kind, status: s.status, content: s.content, metadata: s.metadata,
      errorMessage: s.errorMessage, sourceModifiedAt: s.sourceModifiedAt,
    }).run();
  }
  for (const k of db.select().from(analysisKeyframes).where(eq(analysisKeyframes.fileId, oldFileId)).all()) {
    db.insert(analysisKeyframes).values({
      id: crypto.randomUUID(), fileId: newFileId, stepId: stepIdMap.get(k.stepId) ?? k.stepId,
      filePath: k.filePath, frameIndex: k.frameIndex, timestamp: k.timestamp,
      description: k.description, skipped: k.skipped, skipReason: k.skipReason,
      custom: k.custom, sourceModifiedAt: k.sourceModifiedAt,
    }).run();
  }
  for (const c of db.select().from(analysisAudioChunks).where(eq(analysisAudioChunks.fileId, oldFileId)).all()) {
    db.insert(analysisAudioChunks).values({
      id: crypto.randomUUID(), fileId: newFileId, stepId: stepIdMap.get(c.stepId) ?? c.stepId,
      chunkIndex: c.chunkIndex, startSeconds: c.startSeconds, endSeconds: c.endSeconds,
      filePath: c.filePath, status: c.status, text: c.text, words: c.words,
      language: c.language, languageProbability: c.languageProbability,
      errorMessage: c.errorMessage, sourceModifiedAt: c.sourceModifiedAt,
    }).run();
  }
}
