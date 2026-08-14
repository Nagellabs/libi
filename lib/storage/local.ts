import * as fs from "fs/promises";
import * as path from "path";
import type { FileStorage } from "./types";
import { getLibiStorageDir } from "@/lib/libi-home";
import { assertSafePieceId } from "@/lib/security/pieceId";

export const GLOBAL_STORAGE_DIR = "_global";

/** Monotonic counter for unique temp-file names (process-local). Combined with
 *  pid it makes a temp name that can't collide across concurrent saves. */
let tmpCounter = 0;

export class LocalFileStorage implements FileStorage {
  /** Explicit override passed to the constructor (tests). When unset, the base
   *  dir is resolved LAZILY per call so it always reflects the current
   *  `LIBI_HOME` — a cached value can be wrong if the singleton is constructed
   *  during a cold-boot window before `LIBI_HOME` is effective (worktree dev),
   *  which silently pointed file serving at the wrong home → 404s. */
  private readonly explicitBaseDir?: string;

  constructor(baseDir?: string) {
    this.explicitBaseDir = baseDir;
  }

  private get baseDir(): string {
    return this.explicitBaseDir ?? process.env.STORAGE_DIR ?? getLibiStorageDir();
  }

  private dirForPiece(pieceId: string | null): string {
    // RC-D belt-and-braces: reject any traversal-shaped pieceId BEFORE it
    // reaches the filesystem (throws Error("unsafe_piece_id")), ...
    assertSafePieceId(pieceId);
    const base = path.resolve(this.baseDir);
    const dir = path.resolve(base, pieceId ?? GLOBAL_STORAGE_DIR);
    // ...then verify the computed dir is actually contained in baseDir, mirroring
    // the containment check `localPath` already does for `filename`. This defends
    // against any future escape vector the format guard might miss.
    if (dir !== base && !dir.startsWith(base + path.sep)) {
      throw new Error(`piece directory escapes storage root: ${pieceId}`);
    }
    return dir;
  }

  localPath(pieceId: string | null, filename: string): string {
    const dir = this.dirForPiece(pieceId);
    const resolved = path.resolve(dir, filename);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      throw new Error(`path escapes piece directory: ${filename}`);
    }
    return resolved;
  }

  /**
   * Resolve the absolute path for a file that is about to be served over
   * HTTP, following symlinks and re-verifying containment against the
   * *resolved* piece directory.
   *
   * `localPath`'s resolve+startsWith check is correct against traversal
   * strings (`../..`) but is purely lexical — it does not see through a
   * symlink planted *inside* a piece directory that points somewhere else
   * on disk. An agent has file tools and write access to piece
   * directories, so it can plant one (e.g. a symlink named `leak.mp4`
   * pointing at `~/.ssh/id_rsa`), and the lexical check alone would wave
   * a request for it straight through. `fs.realpath` sees the real target.
   *
   * Deliberately NOT folded into `localPath`: `localPath` is called for
   * paths that don't exist yet (saves, existence checks), and
   * `fs.realpath` throws `ENOENT` on those — this method is only for
   * reads that are about to be streamed to an HTTP client, where the
   * caller has already confirmed the file exists.
   */
  async realPathForRead(pieceId: string | null, filename: string): Promise<string> {
    const dir = this.dirForPiece(pieceId);
    const resolved = this.localPath(pieceId, filename);
    const [real, realDir] = await Promise.all([fs.realpath(resolved), fs.realpath(dir)]);
    if (real !== realDir && !real.startsWith(realDir + path.sep)) {
      throw new Error(`resolved path escapes piece directory: ${filename}`);
    }
    return real;
  }

  async save(pieceId: string | null, filename: string, data: Buffer): Promise<string> {
    const filePath = this.localPath(pieceId, filename);
    // Ensure the full directory path exists (including nested subdirs)
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // ATOMIC write: write to a unique temp file in the SAME directory, then
    // rename over the target. `rename` is atomic on POSIX (same filesystem), so
    // a concurrent reader (e.g. loadManifest's readFile) always sees either the
    // old or the new COMPLETE file — never a truncated/partial one. A plain
    // `fs.writeFile` truncates-then-writes, leaving a window where a concurrent
    // read parses half a file and throws (the rapid-PATCH overlay-drag 500).
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
    try {
      await fs.writeFile(tmpPath, data);
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup of the temp file if the rename never happened.
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    return `${pieceId ?? GLOBAL_STORAGE_DIR}/${filename}`;
  }

  async read(pieceId: string | null, filename: string): Promise<Buffer> {
    const filePath = this.localPath(pieceId, filename);
    return fs.readFile(filePath);
  }

  async exists(pieceId: string | null, filename: string): Promise<boolean> {
    try {
      await fs.access(this.localPath(pieceId, filename));
      return true;
    } catch {
      return false;
    }
  }

  async delete(pieceId: string | null, filename: string): Promise<void> {
    try {
      await fs.unlink(this.localPath(pieceId, filename));
    } catch {
      // ignore if file doesn't exist
    }
  }

  async deletePieceDir(pieceId: string): Promise<void> {
    try {
      await fs.rm(this.dirForPiece(pieceId), { recursive: true, force: true });
    } catch {
      // ignore if directory doesn't exist
    }
  }

  async list(pieceId: string | null): Promise<string[]> {
    try {
      // Hide transient atomic-write temp files (`<name>.tmp-<pid>-<ts>-<n>`) so
      // no consumer (orphan sweeps, file listings) ever sees a half-written file
      // that's about to be renamed into place.
      const entries = await fs.readdir(this.dirForPiece(pieceId));
      return entries.filter((e) => !/\.tmp-\d+-\d+-\d+$/.test(e));
    } catch {
      // return empty array if directory doesn't exist
      return [];
    }
  }

  async remove(pieceId: string | null, filename: string): Promise<void> {
    try {
      await fs.unlink(this.localPath(pieceId, filename));
    } catch {
      // ignore if file doesn't exist
    }
  }
}
