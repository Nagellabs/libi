import fs from "fs";
import path from "path";
import { getLibiStorageDir } from "@/lib/libi-home";
import { removeAnalysisDir } from "./storage";
import { serverLogger as logger } from "@/lib/logger";

const log = logger.child({ tag: "analysis" });
const ANALYSIS_DIR = "_analysis";

/**
 * Remove on-disk analysis byproducts for a single file.
 * DB rows cascade via FK ON DELETE CASCADE — this only handles the filesystem.
 */
export function removeAnalysisForFile(pieceId: string | null, fileId: string): void {
  try {
    removeAnalysisDir(pieceId, fileId);
    log.info({ pieceId, fileId }, "analysis.cleanup.file");
  } catch (err) {
    log.warn({ err, pieceId, fileId }, "analysis.cleanup.file.error");
  }
}

/**
 * Remove the entire `_analysis/` subtree for a piece. Used by piece-delete
 * cascade so we don't have to enumerate every file.
 */
export function removeAnalysisForPiece(pieceId: string): void {
  const dir = path.join(getLibiStorageDir(), pieceId, ANALYSIS_DIR);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log.info({ pieceId }, "analysis.cleanup.piece");
  } catch (err) {
    log.warn({ err, pieceId }, "analysis.cleanup.piece.error");
  }
}
