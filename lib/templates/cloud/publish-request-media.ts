/**
 * A publish request's own example video and poster: the exact bytes the user
 * reviews on the Templates page and the only bytes a confirmed publish sends.
 *
 * `libi.publish_template` resolves the example when it PREPARES — it copies a
 * file or a path, or exports a piece, then transcodes the example and makes
 * the poster (the `template_publish_prepare` job) — into a folder the request
 * owns: `<LIBI_HOME>/template-publish-requests/<requestId>/`. The request's
 * fingerprint is those two files' sha256 plus the template's content
 * (`contentFingerprint`), so the review panel shows exactly them and the
 * `template_publish` job publishes exactly them, re-deriving nothing. A file
 * that changes after it was prepared makes the request `changed`.
 *
 * Work in progress lives under `.preparing/<requestId>/` and is renamed into
 * place in the same synchronous step that records the request, so a folder
 * without a request row is always stale. The folder goes when the request
 * does: on a discard, once its publish succeeded, when a newer preparation
 * replaces it, when the template is deleted, and on the sweep
 * (`sweepPublishRequestMedia`) of folders no request owns.
 *
 * fs only — the MCP child, the store and the jobs all read this.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getLibiHome } from "@/lib/libi-home";
import { CAPS } from "@/lib/templates/cloud/constants";

export const EXAMPLE_FILE = "example.mp4";
export const POSTER_FILE = "poster.jpg";
const PREPARING = ".preparing";
/** A preparation older than this is not running: the export job gives up well before. */
const PREPARING_STALE_MS = 24 * 60 * 60_000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPublishRequestId(id: string): boolean {
  return REQUEST_ID.test(id);
}

function assertRequestId(id: string): void {
  if (!isPublishRequestId(id)) throw new Error(`not a publish request id: ${JSON.stringify(id)}`);
}

export function publishRequestsRoot(): string {
  return path.join(getLibiHome(), "template-publish-requests");
}

/** `<LIBI_HOME>/template-publish-requests/<requestId>` — the request's example.mp4 and poster.jpg. */
export function publishRequestDir(id: string): string {
  assertRequestId(id);
  return path.join(publishRequestsRoot(), id);
}

/** Where a preparation builds the two files before the request is recorded. */
export function preparingDir(id: string): string {
  assertRequestId(id);
  return path.join(publishRequestsRoot(), PREPARING, id);
}

export interface RequestMedia {
  example: Buffer;
  poster: Buffer;
}

/** sha256 of each file: what the request's fingerprint binds. */
export interface RequestMediaDigest {
  example: string;
  poster: string;
}

/**
 * The two files as they are now, read once — or null when either is missing,
 * not a regular file (a planted symlink included), or over its catalog cap.
 * The caller hashes and uses these very buffers: nothing reads the files
 * again between the check and the use.
 */
export async function readRequestMediaIn(dir: string): Promise<RequestMedia | null> {
  const read = async (name: string, cap: number): Promise<Buffer | null> => {
    const file = path.join(dir, name);
    const st = await fsp.lstat(file).catch(() => null);
    if (!st?.isFile() || st.size > cap) return null;
    const buf = await fsp.readFile(file).catch(() => null);
    return buf && buf.byteLength <= cap ? buf : null;
  };
  const example = await read(EXAMPLE_FILE, CAPS.example);
  const poster = await read(POSTER_FILE, CAPS.poster);
  return example && poster ? { example, poster } : null;
}

export function readRequestMedia(id: string): Promise<RequestMedia | null> {
  return readRequestMediaIn(publishRequestDir(id));
}

export function mediaDigest(media: RequestMedia): RequestMediaDigest {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return { example: sha(media.example), poster: sha(media.poster) };
}

/** The review panel's own URL for one of the request's files (the only route that serves them). */
export function requestMediaUrl(id: string, name: typeof EXAMPLE_FILE | typeof POSTER_FILE): string {
  return `/api/templates/cloud/publish-requests/${encodeURIComponent(id)}/media/${name}`;
}

/**
 * Move a finished preparation into place. Synchronous on purpose: the caller
 * records the request in the same tick, so no sweep can see the folder
 * without its row.
 */
export function promotePreparedMedia(id: string): void {
  const to = publishRequestDir(id);
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(preparingDir(id), to);
}

/** Remove a request's folder (and any preparation under its id). Never throws. */
export function removePublishRequestMedia(id: string): void {
  if (!isPublishRequestId(id)) return;
  try {
    fs.rmSync(publishRequestDir(id), { recursive: true, force: true });
    fs.rmSync(preparingDir(id), { recursive: true, force: true });
  } catch {
    // Best effort: the sweep takes whatever is left.
  }
}

/**
 * Remove every request folder no request owns (`liveIds`: the ids of every
 * request row, whichever catalog it was prepared against), and any
 * preparation left over from a run that died. Returns how many it removed.
 */
export function sweepPublishRequestMedia(liveIds: ReadonlySet<string>, now = Date.now()): number {
  const root = publishRequestsRoot();
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === PREPARING) continue;
    if (isPublishRequestId(e.name) && liveIds.has(e.name)) continue;
    fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    removed++;
  }
  let preparing: fs.Dirent[] = [];
  try {
    preparing = fs.readdirSync(path.join(root, PREPARING), { withFileTypes: true });
  } catch {
    // None.
  }
  for (const e of preparing) {
    const p = path.join(root, PREPARING, e.name);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st && now - st.mtimeMs < PREPARING_STALE_MS) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
