import fs from "fs";
import path from "path";
import os from "os";

// Stateful storage for no-arg usage pattern
let _currentTempDir: string | undefined;

/**
 * Creates a temporary directory for test storage.
 *
 * When called WITHOUT arguments (new pattern), it also sets `process.env.LIBI_HOME`
 * so that `getLibiStorageDir()` in production code returns a path inside the temp dir.
 * Call `cleanupTempDir()` (no args) in afterEach to restore and delete.
 *
 * When called WITH no assignment (but with the return value ignored), the stateful
 * dir is tracked internally and can be cleaned up with `cleanupTempDir()`.
 *
 * Legacy callers that capture the return value and pass it to `cleanupTempDir(dir)`
 * are still supported.
 */
export function createTempStorageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-test-"));
  _currentTempDir = dir;
  process.env.LIBI_HOME = dir;
  // NOTE: do not auto-reset the storage singleton here — many tests
  // `vi.mock("@/lib/storage")` without a `resetStorage` export, and calling it
  // would throw in those files. `resetStorage` is exported and tests that need
  // a fresh singleton (e.g. storyboard/storage tests) call it explicitly.
  return dir;
}

/**
 * Cleans up the temp storage directory.
 *
 * - No-arg: cleans up the dir set by the last `createTempStorageDir()` call,
 *   restores LIBI_HOME to the vitest global temp root (or deletes it).
 * - With dir arg: legacy pattern — removes the specified directory only
 *   (does NOT touch LIBI_HOME).
 */
export function cleanupTempDir(dir?: string): void {
  if (dir !== undefined) {
    // Legacy pattern: explicit dir, no LIBI_HOME management
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  // Stateful no-arg pattern
  const toClean = _currentTempDir;
  _currentTempDir = undefined;
  // Remove LIBI_HOME override so subsequent code falls back to global vitest root
  delete process.env.LIBI_HOME;
  if (toClean) {
    fs.rmSync(toClean, { recursive: true, force: true });
  }
}
