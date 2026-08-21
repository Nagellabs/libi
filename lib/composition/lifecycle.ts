import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { loadManifest, saveManifest } from "./persistence";
import { diffManifests, type EnrichedDiff } from "./version-diff";
import { detectMissingFiles, type FileRef } from "./version-files";
import {
  saveCurrentSnapshot,
  loadCurrentSnapshot,
  pushSnapshotToHistory,
  listSnapshotHistory,
  loadHistorySnapshot,
  removeHistorySnapshot,
  type Actor,
  type SnapshotHistoryEntry,
} from "./snapshots";
import { serverLogger as logger } from "@/lib/logger";
import {
  saveStoryboardSnapshot,
  restoreStoryboardFromSnapshot,
} from "@/lib/storyboard/snapshot";
import { navigationEmitter } from "@/lib/navigation-events";
import { EMPTY_MANIFEST } from "./persistence";
import type { CompositionManifest } from "./persistence";

export interface ManifestDiff {
  overlays: { added: number; removed: number; changed: number };
  audioClips: { added: number; removed: number; changed: number };
  totalChanges: number;
}

export function compareStates(snapshot: CompositionManifest, draft: CompositionManifest): ManifestDiff {
  const overlays = countDiff(snapshot.overlays ?? [], draft.overlays ?? []);
  const audioClips = countDiff(snapshot.audioClips ?? [], draft.audioClips ?? []);
  const totalChanges =
    overlays.added + overlays.removed + overlays.changed +
    audioClips.added + audioClips.removed + audioClips.changed;
  return { overlays, audioClips, totalChanges };
}

function diffById<T extends { id: string }>(a: T[], b: T[]) {
  const ma = new Map(a.map((x) => [x.id, x]));
  const mb = new Map(b.map((x) => [x.id, x]));
  const added = [...mb.keys()].filter((k) => !ma.has(k));
  const removed = [...ma.keys()].filter((k) => !mb.has(k));
  const changed = [...mb.keys()].filter((k) => ma.has(k) && JSON.stringify(ma.get(k)) !== JSON.stringify(mb.get(k)));
  return { added, removed, changed };
}

function countDiff<T extends { id: string }>(a: T[], b: T[]) {
  const d = diffById(a, b);
  return { added: d.added.length, removed: d.removed.length, changed: d.changed.length };
}

/** True when a manifest has no overlays and no audio clips. */
function isEmptyManifest(m: CompositionManifest): boolean {
  return (
    (m.overlays?.length ?? 0) === 0 &&
    (m.audioClips?.length ?? 0) === 0
  );
}

export interface PieceState {
  pieceId: string;
  hasDraft: boolean;
  snapshotSummary: string | null; // null when no commit has ever happened
  /** Unix seconds of when the last snapshot was committed. Null when never committed. */
  snapshotCommittedAt: number | null;
  recentSnapshots: SnapshotHistoryEntry[];
}

export interface CommitResult {
  snapshotId: string;
  summary: string;
  committedAt: number;
}

export async function commitDraft(
  pieceId: string,
  meta: { summary: string; actor: Actor },
): Promise<CommitResult> {
  const db = getDb();

  // Read the OLD snapshot's summary off the piece row so we can carry it
  // into the history entry instead of losing it to a placeholder.
  const [pieceRow] = await db.select().from(pieces).where(eq(pieces.id, pieceId));
  if (!pieceRow) throw new Error(`Piece ${pieceId} not found`);

  // Push current snapshot (if any) to history with its original summary.
  //
  // Exception: the very first commit on a brand-new piece. `loadManifest`
  // lazy-inits `current.json` to EMPTY_MANIFEST at piece creation so the
  // two-state invariant holds, which means an empty placeholder snapshot
  // exists before the user has ever committed. Archiving it would litter the
  // version history with a phantom "Previous snapshot" (0 changes, empty
  // scene strip) whose only effect on restore is to wipe the piece blank.
  // Suppress it: skip the push when this is the first-ever commit
  // (`snapshotCommittedAt == null`) AND the current snapshot is empty.
  const currentSnap = await loadCurrentSnapshot(pieceId);
  const isFirstCommitOfEmpty =
    pieceRow.snapshotCommittedAt == null &&
    currentSnap != null &&
    isEmptyManifest(currentSnap);
  let pushedId: string | null = null;
  if (currentSnap && !isFirstCommitOfEmpty) {
    pushedId = await pushSnapshotToHistory(pieceId, currentSnap, {
      summary: pieceRow.snapshotSummary ?? "Previous snapshot",
      actor: "user", // we don't track the prior commit's actor; default to user
    });
  }

  // Promote draft to snapshot
  const draft = await loadManifest(pieceId);
  await saveCurrentSnapshot(pieceId, draft);
  await saveStoryboardSnapshot(pieceId);

  // Clear hasDraft + store the new summary and commit timestamp on the piece row
  const now = new Date();
  await db.update(pieces)
    .set({ hasDraft: false, snapshotSummary: meta.summary, snapshotCommittedAt: now, updatedAt: now })
    .where(eq(pieces.id, pieceId));

  const committedAt = Math.floor(now.getTime() / 1000);
  logger.info({ tag: "snapshot", op: "commit_draft", pieceId, pushedId, summary: meta.summary }, "committed draft");
  navigationEmitter.emit("refresh_query", { queryKey: "piece-state", pieceId });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });

  // The "snapshotId" we return is the id of the just-promoted snapshot.
  // The pushed-to-history snapshot is the OLD one. The promoted one isn't
  // in history yet (it's at `snapshots/current.json`); for return purposes
  // we synthesize an id from the timestamp.
  const snapshotId = `snap-current-${committedAt.toString(36)}`;
  return { snapshotId, summary: meta.summary, committedAt };
}

export async function discardDraft(pieceId: string): Promise<void> {
  const db = getDb();
  const snap = await loadCurrentSnapshot(pieceId);
  if (!snap) {
    // No snapshot exists → reset to empty
    await saveManifest(pieceId, EMPTY_MANIFEST);
  } else {
    await saveManifest(pieceId, snap);
  }
  await restoreStoryboardFromSnapshot(pieceId);
  await db.update(pieces).set({ hasDraft: false, updatedAt: new Date() }).where(eq(pieces.id, pieceId));
  logger.info({ tag: "snapshot", op: "discard_draft", pieceId }, "discarded draft");
  navigationEmitter.emit("refresh_query", { queryKey: "piece-state", pieceId });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
}

export async function restoreSnapshot(pieceId: string, snapshotId: string): Promise<void> {
  const db = getDb();
  const target = await loadHistorySnapshot(pieceId, snapshotId);
  if (!target) throw new Error(`Snapshot ${snapshotId} not found in history`);

  // Look up the chosen target's summary from the history index before we
  // remove it — we'll write this as the piece's new snapshot_summary.
  const history = await listSnapshotHistory(pieceId);
  const targetEntry = history.find((h) => h.id === snapshotId);
  if (!targetEntry) throw new Error(`Snapshot ${snapshotId} missing from history index`);

  const [pieceRow] = await db.select().from(pieces).where(eq(pieces.id, pieceId));
  if (!pieceRow) throw new Error(`Piece ${pieceId} not found`);

  // Archive the current snapshot to history (so the user can come back),
  // preserving its original summary.
  const currentSnap = await loadCurrentSnapshot(pieceId);
  if (currentSnap) {
    await pushSnapshotToHistory(pieceId, currentSnap, {
      summary: pieceRow.snapshotSummary ?? "Pre-restore snapshot",
      actor: "user",
    });
  }

  // Promote the chosen target to current + composition
  await saveCurrentSnapshot(pieceId, target);
  await saveManifest(pieceId, target);

  // Remove the now-promoted snapshot from history (it's at current now)
  await removeHistorySnapshot(pieceId, snapshotId);

  await db.update(pieces)
    .set({ hasDraft: false, snapshotSummary: targetEntry.summary, snapshotCommittedAt: new Date(), updatedAt: new Date() })
    .where(eq(pieces.id, pieceId));
  logger.info({ tag: "snapshot", op: "restore_snapshot", pieceId, snapshotId }, "restored snapshot");
  navigationEmitter.emit("refresh_query", { queryKey: "piece-state", pieceId });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
}

export async function getPieceState(pieceId: string): Promise<PieceState> {
  const db = getDb();
  const [row] = await db.select().from(pieces).where(eq(pieces.id, pieceId));
  if (!row) throw new Error(`Piece ${pieceId} not found`);
  const history = await listSnapshotHistory(pieceId);
  return {
    pieceId,
    hasDraft: row.hasDraft,
    snapshotSummary: row.snapshotSummary,
    snapshotCommittedAt: row.snapshotCommittedAt ? row.snapshotCommittedAt.getTime() / 1000 : null,
    recentSnapshots: history,
  };
}

export type VersionKind = "draft" | "snapshot" | "history";

export interface VersionRow {
  /** "draft" | "current" | history snapshot id. */
  id: string;
  kind: VersionKind;
  summary: string | null;
  /** Unix seconds; null for the live draft. */
  committedAt: number | null;
  actor: Actor;
  /** Change count vs the next-older version (the changelog count). */
  changeCount: number;
  missingFileCount: number;
}

export interface VersionDiffResult {
  id: string;
  kind: VersionKind;
  summary: string | null;
  committedAt: number | null;
  actor: Actor;
  /** Diff of this version vs the next-older version ("what this save introduced"). */
  diff: EnrichedDiff;
  /** Diff of this version vs the CURRENT state (what restoring would change). Null unless a restorable history row. */
  restoreImpact: EnrichedDiff | null;
  missingFiles: FileRef[];
}

interface VersionDescriptor {
  id: string;
  kind: VersionKind;
  summary: string | null;
  committedAt: number | null;
  actor: Actor;
}

/**
 * Ordered version timeline metadata — [draft?, snapshot, ...history] — WITHOUT
 * loading any manifests or computing diffs. Cheap: one piece row + the history
 * index. Shared by getVersionHistory (adds per-row diff counts) and
 * getVersionDiff (needs only the ordering to find a row + its next-older).
 */
async function listVersionDescriptors(pieceId: string): Promise<VersionDescriptor[]> {
  const [row] = await getDb().select().from(pieces).where(eq(pieces.id, pieceId));
  if (!row) throw new Error(`Piece ${pieceId} not found`);
  const history = await listSnapshotHistory(pieceId); // newest first

  const descriptors: VersionDescriptor[] = [];
  if (row.hasDraft) {
    descriptors.push({ id: "draft", kind: "draft", summary: null, committedAt: null, actor: "user" });
  }
  descriptors.push({
    id: "current",
    kind: "snapshot",
    summary: row.snapshotSummary,
    committedAt: row.snapshotCommittedAt ? Math.floor(row.snapshotCommittedAt.getTime() / 1000) : null,
    actor: "user",
  });
  for (const h of history) {
    descriptors.push({ id: h.id, kind: "history", summary: h.summary, committedAt: h.committedAt, actor: h.actor });
  }
  return descriptors;
}

/** Load the manifest for a version id ("draft" | "current" | history id). */
async function loadVersionManifest(pieceId: string, versionId: string): Promise<CompositionManifest> {
  if (versionId === "draft") return loadManifest(pieceId);
  if (versionId === "current") return (await loadCurrentSnapshot(pieceId)) ?? EMPTY_MANIFEST;
  return (await loadHistorySnapshot(pieceId, versionId)) ?? EMPTY_MANIFEST;
}

/**
 * Build the ordered version timeline: [draft?, snapshot, ...history].
 * Each row's changeCount is its diff vs the row directly below it (next-older).
 */
export async function getVersionHistory(pieceId: string): Promise<VersionRow[]> {
  const descriptors = await listVersionDescriptors(pieceId);

  // The list view inherently needs every manifest for its per-row change +
  // missing-file counts. Load each once into a map (EMPTY baseline for the
  // oldest row / a missing snapshot).
  const manifestEntries = await Promise.all(
    descriptors.map(async (d) => [d.id, await loadVersionManifest(pieceId, d.id)] as const),
  );
  const manifestById = new Map(manifestEntries);

  const rows: VersionRow[] = [];
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i];
    const manifest = manifestById.get(d.id) ?? EMPTY_MANIFEST;
    const next = descriptors[i + 1];
    const older = next ? (manifestById.get(next.id) ?? EMPTY_MANIFEST) : EMPTY_MANIFEST;
    // Count DISTINCT missing files, not references: a single deleted video file
    // is referenced by both its scene and its auto-created inline audio clip, so
    // a reference count would report "2 files" for one deleted file on every
    // video scene. The badge/tooltip/restore-warning all want the file count.
    const missing = await detectMissingFiles(manifest, pieceId);
    rows.push({
      id: d.id,
      kind: d.kind,
      summary: d.summary,
      committedAt: d.committedAt,
      actor: d.actor,
      changeCount: diffManifests(older, manifest).totalChanges,
      missingFileCount: new Set(missing.map((r) => r.fileId)).size,
    });
  }
  return rows;
}

/**
 * Detailed diff for one version (vs next-older) + restore impact (vs current) +
 * missing files. Loads ONLY the manifests this view needs (target, next-older,
 * and the current snapshot for a restorable history row) rather than the whole
 * timeline.
 */
export async function getVersionDiff(pieceId: string, versionId: string): Promise<VersionDiffResult> {
  const descriptors = await listVersionDescriptors(pieceId);
  const idx = descriptors.findIndex((d) => d.id === versionId);
  if (idx === -1) throw new Error(`Version ${versionId} not found`);
  const desc = descriptors[idx];

  const manifest = await loadVersionManifest(pieceId, versionId);
  const olderDesc = descriptors[idx + 1];
  const olderManifest = olderDesc ? await loadVersionManifest(pieceId, olderDesc.id) : EMPTY_MANIFEST;

  const diff = diffManifests(olderManifest, manifest);

  // Restore impact only for history rows (the only restorable kind).
  let restoreImpact: EnrichedDiff | null = null;
  if (desc.kind === "history") {
    const current = (await loadCurrentSnapshot(pieceId)) ?? EMPTY_MANIFEST;
    restoreImpact = diffManifests(current, manifest);
  }

  return {
    id: desc.id,
    kind: desc.kind,
    summary: desc.summary,
    committedAt: desc.committedAt,
    actor: desc.actor,
    diff,
    restoreImpact,
    missingFiles: await detectMissingFiles(manifest, pieceId),
  };
}
