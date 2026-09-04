import * as os from "node:os";
import * as path from "node:path";
import { getLibiHome } from "@/lib/libi-home";
import { resolveExportFolder } from "@/lib/db/settings";
// isWindows(), never `process.platform === "win32"` — Turbopack constant-folds
// that comparison against the BUILD machine and deletes the dead branch, so a
// mac-built server would carry the case-sensitive path forever. See
// lib/platform.ts.
import { isWindows } from "@/lib/platform";

/**
 * Which absolute paths `/api/shell/reveal` is willing to open a file manager
 * at — the HTTP fallback used when the Electron preload bridge isn't there
 * (npx / BYO-CLI). Electron's own `shell.showItemInFolder` has no such list;
 * this is defence-in-depth on the route that takes a path from a request
 * body, not a security boundary the product relies on.
 *
 * The set is "roots libi legitimately writes to". `$HOME` and the OS temp dir
 * alone were too narrow: both `LIBI_HOME` and the export output folder are
 * user-configurable and routinely point somewhere else (an external volume,
 * a second drive). A path outside the list is silently skipped, so getting
 * this wrong shows up as a Reveal button that does nothing at all — which is
 * exactly what happened to Reveal-after-export and to the asset Location row.
 */
export function revealRoots(): string[] {
  const roots = [os.homedir(), os.tmpdir(), getLibiHome()];
  try {
    roots.push(resolveExportFolder());
  } catch {
    // The export folder lives in the DB; a failed read must not take the
    // whole allowlist down with it. The other roots still apply.
  }
  return normalizeRoots(roots);
}

/**
 * Drop entries that can't function as a meaningful boundary: anything empty,
 * or equal to the filesystem root. That last one matters — a `LIBI_HOME=/`
 * misconfiguration would otherwise widen the list to every path on the
 * machine while still looking like an allowlist.
 *
 * Relative entries are RESOLVED against the server's cwd, not dropped —
 * `getLibiHome()` returns `process.env.LIBI_HOME` verbatim, so `LIBI_HOME=.`
 * allowlists the cwd. That is the same directory libi is already running out
 * of, so it grants nothing new, but it is worth stating rather than implying
 * relative paths are rejected.
 */
export function normalizeRoots(roots: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of roots) {
    if (!raw) continue;
    const abs = path.resolve(raw);
    if (abs === path.parse(abs).root) continue;
    // Fold when comparing, keep the original casing in the output — the same
    // reasoning as isPathRevealable, so a case-varied duplicate root doesn't
    // survive into the list.
    const seen = isWindows()
      ? out.some((r) => r.toLowerCase() === abs.toLowerCase())
      : out.includes(abs);
    if (!seen) out.push(abs);
  }
  return out;
}

/**
 * True iff `abs` is one of `roots` or sits inside one.
 *
 * Separator-aware on purpose. A bare `abs.startsWith(root)` also matches a
 * sibling whose name merely begins with the root's — `/Users/nadavil` passes
 * a `/Users/nadav` prefix test — which quietly widens the allowlist to
 * directories that were never on it.
 *
 * Case-folded on Windows, where the filesystem is case-insensitive and the
 * two sides of this comparison come from different places: `os.homedir()` and
 * `getLibiHome()` supply the roots, while the path under test came out of the
 * DB or an export job. `C:\Users\Nadav\…` against a `c:\users\nadav` root is
 * the same directory to Windows but a mismatch to `===`, and the failure mode
 * is the silent one — a Reveal button that does nothing at all. macOS is
 * usually case-insensitive too, but its paths are not compared across sources
 * this way, and folding there would weaken the check on a case-sensitive APFS
 * volume for no gain.
 */
export function isPathRevealable(
  abs: string,
  roots: string[],
  // Seam for tests only. The path module is platform-native at runtime, so a
  // ubuntu CI box can never exercise backslash separators or `C:\` drive
  // roots — and Windows path handling is precisely where this repo has
  // shipped an outage before. Passing `path.win32` lets those shapes be
  // tested for real instead of asserted from a POSIX box.
  pathMod: Pick<typeof path, "resolve" | "sep"> = path,
  windows: boolean = isWindows(),
): boolean {
  const fold = (p: string) => (windows ? p.toLowerCase() : p);
  const resolved = fold(pathMod.resolve(abs));
  return roots.some((raw) => {
    let root = fold(pathMod.resolve(raw));
    // `resolve` returns SOME roots with a trailing separator — a Windows UNC
    // share resolves `\\nas\libi` to `\\nas\libi\`, and a drive root to
    // `C:\`. Appending another separator then yields `\\nas\libi\\`, which
    // nothing starts with, so every path under such a root was rejected and
    // the reveal silently did nothing. Strip it before comparing.
    if (root.length > 1 && root.endsWith(pathMod.sep)) {
      root = root.slice(0, -pathMod.sep.length);
    }
    return resolved === root || resolved.startsWith(root + pathMod.sep);
  });
}
