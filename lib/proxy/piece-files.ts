import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import type { FileRecord } from "@/lib/db/schema/types";

/*
 * The files a piece's preview reads: its own rows, and the library (global)
 * files its composition uses (the preview looks a file up in both lists:
 * `proxyStatusForFile`). Shared by the proxy LRU's in-use protection and the
 * re-make on open (ensure.ts). No job imports here: lru.ts is loaded by the
 * proxy_gen runner.
 */

/**
 * The library (global) files `pieceId`'s composition references: overlay and
 * tracked-overlay `fileId`s and audio clip `fileId`s. Read straight from
 * `composition.json`, without `loadManifest`'s hydration. Empty on any error.
 */
export function referencedFileIds(pieceId: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(getLibiStorageDir(), pieceId, "composition.json"), "utf8");
    const m = JSON.parse(raw) as { overlays?: unknown; audioClips?: unknown };
    const ids = new Set<string>();
    const take = (v: unknown) => {
      if (typeof v === "string" && v.length > 0) ids.add(v);
    };
    for (const o of Array.isArray(m.overlays) ? m.overlays : []) {
      if (!o || typeof o !== "object") continue;
      take((o as { fileId?: unknown }).fileId);
      const c = (o as { content?: unknown }).content;
      if (c && typeof c === "object") take((c as { fileId?: unknown }).fileId);
    }
    for (const a of Array.isArray(m.audioClips) ? m.audioClips : []) {
      if (a && typeof a === "object") take((a as { fileId?: unknown }).fileId);
    }
    return [...ids];
  } catch {
    return [];
  }
}

/** The rows the preview of `pieceId` reads: the piece's own files and the library files it uses. */
export function pieceAndLibraryFiles(pieceId: string): FileRecord[] {
  const db = getDb();
  const own = db.select().from(files).where(eq(files.pieceId, pieceId)).all();
  const refs = referencedFileIds(pieceId);
  const library = refs.length > 0 ? db.select().from(files).where(and(isNull(files.pieceId), inArray(files.id, refs))).all() : [];
  return [...own, ...library];
}
