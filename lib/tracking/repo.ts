import { eq } from "drizzle-orm";
import { tracks } from "@/lib/db/schema/sqlite";
import type { TrackRow } from "@/lib/db/schema/types";
import type { TrackMethod } from "@/lib/tracking/types";

export interface InsertTrackRow {
  id: string;
  fileId: string;
  subjectId?: string;
  label?: string;
  method: TrackMethod;
  framerate: number;
  durationSec: number;
  sampleCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any; // Drizzle instance — typed loosely so the module stays import-free of drizzle generics

export async function insertTrackRow(db: Db, row: InsertTrackRow): Promise<void> {
  await db.insert(tracks).values({ ...row, createdAt: new Date() });
}

export async function getTrackRow(db: Db, trackId: string): Promise<TrackRow | null> {
  const r = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  return r[0] ?? null;
}

export async function listTracksByFile(db: Db, fileId: string): Promise<TrackRow[]> {
  return db.select().from(tracks).where(eq(tracks.fileId, fileId));
}

export async function deleteTrackRow(db: Db, trackId: string): Promise<void> {
  await db.delete(tracks).where(eq(tracks.id, trackId));
}
