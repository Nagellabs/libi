import { getStorage } from "@/lib/storage";
import type { CompositionManifest } from "./persistence";

export const HISTORY_RING_SIZE = 10;

const CURRENT_SNAPSHOT_PATH = "snapshots/current.json";
const HISTORY_DIR = "snapshots/history";
const HISTORY_INDEX_PATH = "snapshots/history/index.json";

export type Actor = "agent" | "user";

export interface SnapshotHistoryEntry {
  id: string;
  summary: string;
  actor: Actor;
  committedAt: number; // unix seconds
}

interface HistoryIndex {
  entries: SnapshotHistoryEntry[]; // newest first
}

export async function saveCurrentSnapshot(
  pieceId: string,
  manifest: CompositionManifest,
): Promise<void> {
  const storage = await getStorage();
  const data = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
  await storage.save(pieceId, CURRENT_SNAPSHOT_PATH, data, "application/json");
}

export async function loadCurrentSnapshot(pieceId: string): Promise<CompositionManifest | null> {
  const storage = await getStorage();
  if (!(await storage.exists(pieceId, CURRENT_SNAPSHOT_PATH))) return null;
  const data = await storage.read(pieceId, CURRENT_SNAPSHOT_PATH);
  return JSON.parse(data.toString("utf-8")) as CompositionManifest;
}

export async function pushSnapshotToHistory(
  pieceId: string,
  manifest: CompositionManifest,
  meta: { summary: string; actor: Actor },
): Promise<string> {
  const storage = await getStorage();
  const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const committedAt = Math.floor(Date.now() / 1000);

  // Write the snapshot file
  await storage.save(
    pieceId,
    `${HISTORY_DIR}/${id}.json`,
    Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
    "application/json",
  );

  // Update index (newest first), evict oldest if over ring size
  const index = await readIndex(pieceId);
  index.entries.unshift({ id, summary: meta.summary, actor: meta.actor, committedAt });
  const evicted = index.entries.splice(HISTORY_RING_SIZE);
  for (const e of evicted) {
    await storage.remove(pieceId, `${HISTORY_DIR}/${e.id}.json`).catch(() => {});
  }
  await writeIndex(pieceId, index);

  return id;
}

export async function listSnapshotHistory(pieceId: string): Promise<SnapshotHistoryEntry[]> {
  const index = await readIndex(pieceId);
  return index.entries;
}

export async function loadHistorySnapshot(
  pieceId: string,
  snapshotId: string,
): Promise<CompositionManifest | null> {
  const storage = await getStorage();
  const filePath = `${HISTORY_DIR}/${snapshotId}.json`;
  if (!(await storage.exists(pieceId, filePath))) return null;
  const data = await storage.read(pieceId, filePath);
  return JSON.parse(data.toString("utf-8")) as CompositionManifest;
}

export async function removeHistorySnapshot(pieceId: string, snapshotId: string): Promise<void> {
  const storage = await getStorage();
  await storage.remove(pieceId, `${HISTORY_DIR}/${snapshotId}.json`).catch(() => {});
  const index = await readIndex(pieceId);
  index.entries = index.entries.filter((e) => e.id !== snapshotId);
  await writeIndex(pieceId, index);
}

async function readIndex(pieceId: string): Promise<HistoryIndex> {
  const storage = await getStorage();
  if (!(await storage.exists(pieceId, HISTORY_INDEX_PATH))) return { entries: [] };
  const data = await storage.read(pieceId, HISTORY_INDEX_PATH);
  return JSON.parse(data.toString("utf-8")) as HistoryIndex;
}

async function writeIndex(pieceId: string, index: HistoryIndex): Promise<void> {
  const storage = await getStorage();
  await storage.save(
    pieceId,
    HISTORY_INDEX_PATH,
    Buffer.from(JSON.stringify(index, null, 2), "utf-8"),
    "application/json",
  );
}
