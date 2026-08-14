import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getLibiStorageDir } from "@/lib/libi-home";
import type { Track } from "@/lib/tracking/types";
import { normalizeTrack } from "@/lib/tracking/segments";

function tracksDir(pieceId: string) {
  return join(getLibiStorageDir(), pieceId, "_tracks");
}

function trackPath(pieceId: string, trackId: string) {
  return join(tracksDir(pieceId), `${trackId}.json`);
}

export async function writeTrack(
  pieceId: string,
  track: Track
): Promise<void> {
  await mkdir(tracksDir(pieceId), { recursive: true });
  await writeFile(trackPath(pieceId, track.id), JSON.stringify(track));
}

export async function readTrack(
  pieceId: string,
  trackId: string
): Promise<Track | null> {
  try {
    const raw = await readFile(trackPath(pieceId, trackId), "utf8");
    return normalizeTrack(JSON.parse(raw) as Track);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteTrack(
  pieceId: string,
  trackId: string
): Promise<void> {
  try {
    await unlink(trackPath(pieceId, trackId));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
