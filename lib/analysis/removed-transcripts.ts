import fs from "node:fs";
import path from "node:path";
import { getLibiHome } from "@/lib/libi-home";
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Transcripts a boot migration removed, waiting to be told to the user
 * (review round 5, M7). The transcript re-time (retime-audio-lead.ts) removes a
 * FLAC-in-MP4 cut's transcript, whose old decode was garbled; an agent that
 * expected it (it wrote captions from it) would otherwise find none, and
 * nothing would say why.
 *
 * The same pattern as the legacy canvas-scene notice
 * (hooks/editor/use-legacy-scenes-notice.ts): the server holds what the user
 * must be told, GET /api/pieces/:id/composition reports it, and the editor
 * shows it once and acknowledges it (POST …/composition/removed-transcripts-notice).
 * Nothing is derived from the piece here (the transcript is gone), so the
 * entries themselves are kept, in `<LIBI_HOME>/state/transcripts-removed.json`
 * rather than a new column: `{ [pieceId | "_global"]: [{ fileId, name }] }`. A
 * library file's entry ("_global") is told on the next open of any piece. A
 * deleted piece's entries go with it (lib/pieces/delete-piece.ts), and so does
 * a deleted file's (lib/files/delete-file.ts); a file gone some other way is
 * never named (`pendingRemovedTranscripts` checks its row).
 *
 * Written by the studio (the boot sweep, the acknowledgement) and, through
 * piece and file deletes, by the MCP child too: every write is a temp file +
 * rename, so a crash never leaves it half written and a reader never sees a
 * torn file; two writers racing can lose one update, at worst a notice shown
 * once more or not at all (review m4).
 */
export interface RemovedTranscript {
  fileId: string;
  /** The file's display name, as the user knows it. */
  name: string;
}

const GLOBAL_KEY = "_global";
export const REMOVED_TRANSCRIPTS_FILE = "transcripts-removed.json";

type Store = Record<string, RemovedTranscript[]>;

function storePath(): string {
  return path.join(getLibiHome(), "state", REMOVED_TRANSCRIPTS_FILE);
}

function read(): Store {
  try {
    const v = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Store = {};
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const ok = list.filter(
        (e): e is RemovedTranscript =>
          !!e && typeof e === "object" && typeof (e as RemovedTranscript).fileId === "string" && typeof (e as RemovedTranscript).name === "string",
      );
      if (ok.length > 0) out[k] = ok;
    }
    return out;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const file = storePath();
  if (Object.keys(store).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Record that `fileId`'s transcript was removed, to tell the user on the piece's next open. Idempotent. */
export function recordRemovedTranscript(pieceId: string | null, entry: RemovedTranscript): void {
  const store = read();
  const key = pieceId ?? GLOBAL_KEY;
  const list = store[key] ?? [];
  if (!list.some((e) => e.fileId === entry.fileId)) list.push(entry);
  store[key] = list;
  write(store);
}

/** What opening `pieceId` has to tell: its own files' removed transcripts, then the library's. */
export function pendingRemovedTranscripts(pieceId: string): RemovedTranscript[] {
  try {
    const store = read();
    const all = [...(store[pieceId] ?? []), ...(store[GLOBAL_KEY] ?? [])];
    if (all.length === 0) return all;
    // A file deleted since is not named.
    const alive = new Set(
      getDb().select({ id: files.id }).from(files).where(inArray(files.id, all.map((e) => e.fileId))).all().map((r) => r.id),
    );
    return all.filter((e) => alive.has(e.fileId));
  } catch (err) {
    logger.warn({ tag: "analysis", op: "removed_transcripts_read_failed", pieceId, err }, "analysis.removed_transcripts.read_failed");
    return [];
  }
}

/** The user has been told about these (opened in `pieceId`): forget them. Returns how many went. */
export function acknowledgeRemovedTranscripts(pieceId: string, fileIds: readonly string[]): number {
  const store = read();
  const ids = new Set(fileIds);
  let dropped = 0;
  for (const key of [pieceId, GLOBAL_KEY]) {
    const list = store[key];
    if (!list) continue;
    const kept = list.filter((e) => !ids.has(e.fileId));
    dropped += list.length - kept.length;
    if (kept.length > 0) store[key] = kept;
    else delete store[key];
  }
  if (dropped > 0) write(store);
  return dropped;
}

/** A deleted file's notice goes with it. */
export function forgetRemovedTranscriptForFile(fileId: string): void {
  const store = read();
  let changed = false;
  for (const key of Object.keys(store)) {
    const kept = store[key].filter((e) => e.fileId !== fileId);
    if (kept.length === store[key].length) continue;
    changed = true;
    if (kept.length > 0) store[key] = kept;
    else delete store[key];
  }
  if (changed) write(store);
}

/** A deleted piece's entries go with it. */
export function forgetRemovedTranscriptsForPiece(pieceId: string): void {
  const store = read();
  if (!(pieceId in store)) return;
  delete store[pieceId];
  write(store);
}
