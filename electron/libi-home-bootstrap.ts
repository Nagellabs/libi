// electron/libi-home-bootstrap.ts
//
// MUST be the FIRST import in `electron/main.ts`. It pins the packaged app's
// on-disk identity and publishes `process.env.LIBI_HOME` — in that order —
// before anything else in the bundle can act on either.
//
// Why it exists as its own module rather than a couple of lines in main.ts:
// ES import bindings are hoisted, so every module main.ts imports is fully
// evaluated BEFORE main.ts's own body runs. Any of them that reads the data
// root at module scope therefore read it too early. `lib/logger.ts` did
// exactly that and wrote the whole of Category A into the developer's
// `~/.libi` instead of the app's own home.
//
// The logger no longer resolves its destination at import time (it opens on
// first write), so this file is not load-bearing for that specific bug any
// more — it is the belt to the logger's braces, and it closes the same hazard
// for anything else that resolves the home during module evaluation. Between
// the two, routing is correct whether a consumer reads the home at import time
// or at first use.
//
// ── Why the app name is pinned to a literal ───────────────────────────────
// Electron derives userData from `app.getName()`, which for a packaged build
// reads `Resources/app/package.json` — `productName` when present, otherwise
// `name`. libi's `name` is the NPM REGISTRY identity, so renaming the package
// `libi` → `@nagellabs/libi` silently relocated the packaged app's entire data
// root from `…/Application Support/libi` to
// `…/Application Support/@nagellabs/libi` — SQLite DB, pieces, agent
// workspace, runtime-installed binaries, all of it.
//
// A packaging identity and a registry identity are different things; coupling
// them is what caused that. The name below is therefore a LITERAL and must
// never be derived from package.json. Renaming the npm package must never
// move a user's data again.
//
// `electron-builder.yml`'s `productName: "Libi"` does NOT do this job. It
// names the .app bundle, CFBundleName and the installer artifacts, but
// electron-builder does not copy it into `Resources/app/package.json` (that
// needs `extraMetadata`), and that inner file is what Electron actually reads.
// Were it copied, `app.getName()` would become "Libi" — a THIRD path,
// different again from both of the above.
//
// Both calls below are load-bearing, and this was MEASURED on Electron 36,
// not assumed:
//   * `setName` alone fixes userData only while nothing has read userData
//     yet. Electron caches the resolved path on first read, so a
//     read-then-`setName` ordering silently keeps the old directory — an
//     invariant one stray earlier import away from breaking.
//   * `setPath` alone leaves `app.getName()` reporting the registry name,
//     which surfaces in the macOS menu bar, notification sender identity and
//     the crash reporter.
// Together the name is honest AND the path is deterministic regardless of
// read ordering.
//
// Dev is deliberately untouched, for two reasons. `LIBI_HOME` is already set
// by the CLI parent (and by the worktree bootstrap) before Electron starts,
// and an unpackaged app must keep using it — `app.getPath("userData")` in dev
// is Electron's shared profile directory, not a libi home. More sharply:
// pinning the name in dev would repoint a bare `electron .` (no `LIBI_HOME`)
// out of Electron's shared profile and directly INTO the packaged app's real
// userData, letting a dev run scribble on an installed user's data.
//
// ── LIBI_USER_DATA_DIR: a second packaged Libi beside the first ────────────
// QA needs to boot a candidate build while the operator's own Libi.app keeps
// running. It can't by default: userData is pinned above for every packaged
// launch, `main.ts` takes Electron's single-instance lock keyed on it, and
// LIBI_HOME defaults from it — so a second copy just focuses the first and
// quits. `LIBI_USER_DATA_DIR`, when set to an ABSOLUTE path, replaces the
// pinned directory before anything reads it: the second copy gets its own
// lock, its own Chromium profile, and (unless LIBI_HOME is set explicitly) its
// own libi home.
//
// An explicit opt-in only. Nothing in libi ever sets it. A relative or empty
// value is IGNORED rather than resolved — relative to what? a Finder launch's
// cwd is `/` — and the directory must exist or be creatable; either failure
// falls back to the default and says so in the sync log. Dev ignores it:
// dev's profile is `<LIBI_HOME>/electron-profile` (main.ts), and LIBI_HOME is
// already the per-worktree knob there.
import { app } from "electron";
import fs from "fs";
import path from "path";
import { mainSyncLog } from "./sync-log";

/**
 * The packaged app's identity on disk — the `Application Support/<name>`
 * directory and `app.getName()`. A literal by design: see the header above
 * before changing it, because changing it moves every existing install's data.
 */
export const LIBI_APP_NAME = "libi";

/** The QA opt-in described in the header. Never set by libi itself. */
export const USER_DATA_DIR_ENV = "LIBI_USER_DATA_DIR";

/**
 * Judge a `LIBI_USER_DATA_DIR` value: `null` when unset (nothing to do or
 * say), `{ dir }` — normalized — when it is an absolute path on THIS platform,
 * otherwise `{ ignored }` with the reason. Absoluteness follows
 * `process.platform`, so `C:\QA` is honoured on Windows and ignored on macOS.
 */
export function resolveUserDataOverride(
  value: string | undefined,
): { dir: string } | { ignored: string } | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return { ignored: "empty value" };
  const flavour = process.platform === "win32" ? path.win32 : path.posix;
  if (!flavour.isAbsolute(trimmed)) return { ignored: `not an absolute path: ${JSON.stringify(value)}` };
  // Drive-relative (`C:QA`) is not absolute per win32.isAbsolute; UNC and
  // `C:\…` are. resolve() on an absolute path never consults the cwd.
  return { dir: flavour.resolve(trimmed) };
}

if (app.isPackaged) {
  // Decided before the pin so the pin below is the ONLY setPath and still
  // precedes every read. Creating the directory here (not later) is what
  // lets a bad value fall back instead of failing inside Chromium.
  const override = resolveUserDataOverride(process.env[USER_DATA_DIR_ENV]);
  let userDataDir = path.join(app.getPath("appData"), LIBI_APP_NAME);
  let overrideNote: string | null = null;
  if (override && "dir" in override) {
    try {
      fs.mkdirSync(override.dir, { recursive: true });
      userDataDir = override.dir;
      overrideNote = `${USER_DATA_DIR_ENV}: userData → ${override.dir}`;
    } catch (err) {
      overrideNote = `${USER_DATA_DIR_ENV} ignored (cannot create ${override.dir}: ${(err as Error).message}); using ${userDataDir}`;
    }
  } else if (override) {
    overrideNote = `${USER_DATA_DIR_ENV} ignored (${override.ignored}); using ${userDataDir}`;
  }

  // Order is the whole point of this block, and the reason the pin and the
  // read live together rather than in two places that can drift apart: the
  // identity must be fixed BEFORE anything resolves userData.
  app.setName(LIBI_APP_NAME);
  app.setPath("userData", userDataDir);

  // Only now is `userData` the directory we mean. Note this runs even when
  // `LIBI_HOME` is already set: `userData` is also Chromium's profile root
  // (cookies, GPUCache, SingletonLock), which needs pinning independently of
  // where libi's own data is told to go.
  process.env.LIBI_HOME ??= app.getPath("userData");

  // Logged after LIBI_HOME is published so the line lands in THIS instance's
  // `<LIBI_HOME>/logs/electron-main-sync.log`, not the operator's.
  if (overrideNote) mainSyncLog(`libi-home-bootstrap: ${overrideNote}`);
}
