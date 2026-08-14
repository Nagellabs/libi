/** Abstract file storage interface — works for local filesystem and cloud */
export interface FileStorage {
  /** Save a file. Returns the relative storage path. */
  save(pieceId: string | null, filename: string, data: Buffer, contentType?: string): Promise<string>;

  /** Read a file's contents */
  read(pieceId: string | null, filename: string): Promise<Buffer>;

  /** Check if a file exists */
  exists(pieceId: string | null, filename: string): Promise<boolean>;

  /** Delete a file */
  delete(pieceId: string | null, filename: string): Promise<void>;

  /** Delete all files for a piece */
  deletePieceDir(pieceId: string): Promise<void>;

  /** List all filenames in a piece directory. Returns empty array if dir doesn't exist. */
  list(pieceId: string | null): Promise<string[]>;

  /** Remove a specific file. Returns early if file doesn't exist. */
  remove(pieceId: string | null, filename: string): Promise<void>;

  /** Get the absolute local path for a file (for serving) */
  localPath(pieceId: string | null, filename: string): string;

  /**
   * Absolute local path for a file about to be served over HTTP. Like
   * `localPath`, but also follows symlinks (`fs.realpath`) and re-verifies
   * containment against the resolved directory, so a symlink planted
   * inside a piece dir can't be used to serve a file from outside it.
   * Throws if the target doesn't exist or resolves outside the piece dir —
   * callers must already have confirmed existence (e.g. via `exists`).
   */
  realPathForRead(pieceId: string | null, filename: string): Promise<string>;
}
