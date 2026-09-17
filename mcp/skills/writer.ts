import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiAgentDir } from "@/lib/libi-home";
import type { Skill } from "./types";

/** The two project dialects libi's OWN agent dir carries. Outside it, one dialect per agent (see lib/agents/skill-targets.ts). */
export const SKILL_DIALECTS: readonly string[] = [".claude/skills", ".agents/skills"];

/** The retired codex skill dir. Codex's real project skill-discovery path is
 *  `.agents/skills`, so the old `.codex/skills` mirror is now dead; a one-time
 *  sweep removes the libi-owned content it left behind. */
const LEGACY_CODEX_DIALECT = ".codex/skills";

/** Ownership marker that a libi-generated GEMINI.md carried. Its presence is
 *  the only signal the orphan sweep uses to decide a GEMINI.md is ours to
 *  delete — a user-authored GEMINI.md never contains it. */
const GEMINI_OWNED_MARKER = "<!-- libi-skills-start -->";
const LEGACY_GEMINI_FILE = "GEMINI.md";

function sha(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * A `tag: "skills"` log's substitute for a raw caught error: only its errno
 * `code` (e.g. `EACCES`) and constructor `name` — never `message` or `stack`,
 * since either can embed a filesystem path, and a user's folder or project
 * name can be private. Exported for `mcp/skills/installs.ts` and the
 * skill-installs API routes, which log the same kind of fs/manifest failures.
 */
export function sanitizeErrForLog(err: unknown): { code: string | null; name: string } {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return {
    code: typeof code === "string" ? code : null,
    name: err instanceof Error ? err.name : Object.prototype.toString.call(err),
  };
}

/**
 * A supporting file's path inside its skill folder, spelled the platform's way: its separator, with
 * `.` and doubled separators dropped. A skill's `relPath` may be written with `/` while the folder
 * listing joins with `\` on Windows; compared as written, the same file reads as unwanted and is
 * deleted and rewritten on every sync. `p` lets a test apply another platform's rules.
 */
export function supportingFileKey(relPath: string, p: path.PlatformPath = path): string {
  return p.normalize(relPath);
}

/** Where a supporting file goes inside `skillDir`: its nested path, whichever separator `relPath` uses. */
export function supportingFilePath(skillDir: string, relPath: string, p: path.PlatformPath = path): string {
  return p.join(skillDir, supportingFileKey(relPath, p));
}

function writeIfChanged(absPath: string, contents: string | Buffer): boolean {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  // A link where libi keeps a file is replaced, never written through: its
  // target is somewhere libi does not own.
  if (lstatOrNull(absPath)?.isSymbolicLink()) fs.unlinkSync(absPath);
  if (fs.existsSync(absPath)) {
    const existing = fs.readFileSync(absPath);
    const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (sha(existing) === sha(next)) return false;
  }
  fs.writeFileSync(absPath, contents);
  return true;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** One entry directly in a skills root, classified WITHOUT following links:
 *  `dir` is a real directory; a symlink or junction (to a dir, a file, or nothing) is `link`. */
interface RootEntry {
  name: string;
  kind: "dir" | "link" | "other";
}

/** Every entry in `root` except the manifest — dirs, links (live or dangling) and files alike.
 *  Each is classified by `lstat`, never by the listing's own types: on Windows the
 *  listing marks EVERY reparse point as a link (a OneDrive Files On-Demand folder
 *  included), while lstat reports a link only for a symlink or junction. An entry
 *  that vanished between the listing and its lstat is left out. */
function listRootEntries(root: string): RootEntry[] {
  if (!lstatOrNull(root)) return [];
  const entries: RootEntry[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === MANIFEST_FILE) continue;
    const stat = lstatOrNull(path.join(root, e.name));
    if (!stat) continue;
    entries.push({ name: e.name, kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "other" });
  }
  return entries;
}

/** A real directory right now, by lstat — see `listRootEntries` for why not the listing's types. */
function isRealDir(p: string): boolean {
  return lstatOrNull(p)?.isDirectory() ?? false;
}

/** Recursively remove `p` only when it is a real directory right now (checked
 *  with lstat, so a link is never followed). `rmSync` itself unlinks nested
 *  links rather than descending into them. */
function removeRealDir(p: string): boolean {
  if (!isRealDir(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

/** Remove every manifest-listed REAL dir in `root`, by exact name. A listed name
 *  that is now a link, a file, or only a differently cased dir is left alone. */
function removeManagedDirs(root: string, managed: Set<string>): number {
  let removed = 0;
  for (const entry of listRootEntries(root)) {
    if (entry.kind === "dir" && managed.has(entry.name) && removeRealDir(path.join(root, entry.name))) removed++;
  }
  return removed;
}

function pruneEmptyDirs(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const childPath = path.join(root, entry.name);
    if (isRealDir(childPath)) {
      pruneEmptyDirs(childPath);
      if (fs.readdirSync(childPath).length === 0) {
        fs.rmdirSync(childPath);
      }
    }
  }
}

/**
 * One-time orphan sweep: delete a legacy libi-generated `GEMINI.md` left over
 * from when the writer inlined skills into it. Only deletes when the file
 * carries the libi ownership marker — a user-authored GEMINI.md without the
 * marker is left untouched; a missing file is a no-op. Wrapped in try/catch so
 * a sweep failure never breaks skill writing.
 */
export function sweepLegacyGeminiFile(workspaceDir: string): void {
  const filePath = path.join(workspaceDir, LEGACY_GEMINI_FILE);
  try {
    if (!fs.existsSync(filePath)) return;
    const contents = fs.readFileSync(filePath, "utf-8");
    if (contents.includes(GEMINI_OWNED_MARKER)) {
      fs.rmSync(filePath, { force: true });
    }
  } catch (err) {
    logger.warn({ err: sanitizeErrForLog(err), tag: "skills", op: "gemini_sweep_failed" }, "gemini.sweep_failed");
  }
}

const MANIFEST_FILE = ".libi-managed.json";

/**
 * True when `name` is safe to treat as a plain skill folder name directly
 * under a skills root: non-empty, not `.`/`..`, no path separators, no NUL,
 * and not otherwise reinterpretable as a path (absolute or multi-segment).
 * The manifest is untrusted input — every consumer (orphan cleanup,
 * `removeSkillsFromRoot`, the legacy dialect sweep) `rmSync`s
 * `path.join(root, name)`, so a name like `../x`, `..`, an absolute path, or
 * one containing a separator must never reach them.
 */
function isPlainSkillName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return path.basename(name) === name;
}

/**
 * True when a supporting file's path stays inside its skill folder: non-empty,
 * relative on every platform, no NUL, and no `..` segment under either separator.
 */
function isPlainRelativePath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return false;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).every((segment) => segment !== "..");
}

/**
 * The skills an external root may receive: a plain folder name, and plain relative
 * paths for every supporting file. Anything else could write outside its own folder
 * (or outside the root), so the whole skill is left out and only the count is logged —
 * a skill's name can be as private as a folder's.
 */
function externallyWritableSkills(skills: Skill[]): Skill[] {
  const safe = skills.filter(
    (s) => isPlainSkillName(s.name) && s.supportingFiles.every((f) => isPlainRelativePath(f.relPath)),
  );
  if (safe.length !== skills.length) {
    logger.warn({ rejected: skills.length - safe.length, tag: "skills", op: "skills_rejected" }, "skills.skills_rejected");
  }
  return safe;
}

/** A manifest file that exists but could not be read or parsed. */
const UNREADABLE_MANIFEST = Symbol("unreadable-manifest");

/** Names of skill dirs libi wrote previously; null when no manifest exists;
 *  `UNREADABLE_MANIFEST` when one exists but cannot be read or is not a
 *  manifest (for instance another process's write caught half-way).
 *  Entries that aren't plain folder names are dropped — see `isPlainSkillName`.
 *  `warn` logs the drop; only the paths that act on the manifest pass it, so a
 *  plain read (`managedSkillNames`) stays quiet. */
function readManifest(root: string, opts: { warn?: boolean } = {}): Set<string> | null | typeof UNREADABLE_MANIFEST {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, MANIFEST_FILE), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : UNREADABLE_MANIFEST;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNREADABLE_MANIFEST;
  }
  const raw = (parsed as { managed?: unknown } | null)?.managed;
  if (!Array.isArray(raw)) return UNREADABLE_MANIFEST;
  const names = raw.filter((n: unknown): n is string => typeof n === "string" && isPlainSkillName(n));
  if (opts.warn && names.length !== raw.length) {
    logger.warn(
      { rejected: raw.length - names.length, tag: "skills", op: "manifest_names_rejected" },
      "skills.manifest_names_rejected",
    );
  }
  return new Set(names);
}

/** `readManifest` for the paths that only ever remove what a manifest lists:
 *  an unreadable manifest names nothing, so nothing is removed. */
function readManagedNames(root: string, opts: { warn?: boolean } = {}): Set<string> | null {
  const manifest = readManifest(root, opts);
  return manifest === UNREADABLE_MANIFEST ? null : manifest;
}

/**
 * Replace the manifest atomically: a unique temp file in the same dir, renamed
 * over it. The Next server and libi's MCP process both sync the same roots, so
 * a plain write could be read half-done by the other. An unchanged manifest is
 * not rewritten. A link at the manifest's path is replaced, never written
 * through. On failure the temp file is removed and the error rethrown; one a
 * crash strands is cleared by the next write to the root (`clearCrashedTempManifests`).
 */
function writeManagedNames(root: string, names: Set<string>): void {
  const target = path.join(root, MANIFEST_FILE);
  const contents = JSON.stringify({ managed: [...names].sort() }, null, 2) + "\n";
  if (!lstatOrNull(target)?.isSymbolicLink()) {
    try {
      if (fs.readFileSync(target, "utf-8") === contents) return;
    } catch {
      // absent or unreadable: write it
    }
  }
  const temp = path.join(root, `${MANIFEST_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, contents, { flag: "wx" });
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // the original error is the one worth reporting
    }
    throw err;
  }
}

/** Short and path-free, since an install row shows it (at most its first 120 characters).
 *  Deleting only the manifest would leave libi's folders there looking like the user's —
 *  skipped from then on — so the recovery names both. Removal gets its own wording
 *  ("to remove them") — the write message ("to reinstall them") reads backwards when
 *  the user just pressed Remove. */
const UNREADABLE_MANIFEST_WRITE_MESSAGE =
  "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to reinstall them.";
const UNREADABLE_MANIFEST_REMOVE_MESSAGE =
  "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to remove them.";

/** The error for an external root whose manifest exists but cannot be read. Logs
 *  only `action` — never the root, which is a filesystem path a user's project
 *  folder name can make private. */
function unreadableManifestError(action: "write" | "remove"): Error {
  logger.warn({ action, tag: "skills", op: "manifest_unreadable" }, "skills.manifest_unreadable");
  return new Error(action === "remove" ? UNREADABLE_MANIFEST_REMOVE_MESSAGE : UNREADABLE_MANIFEST_WRITE_MESSAGE);
}

/** Exactly the temp name `writeManagedNames` uses: `<manifest>.<pid>.<12 hex>.tmp`. */
const TEMP_MANIFEST_NAME = /^\.libi-managed\.json\.\d+\.[0-9a-f]{12}\.tmp$/;
/** Older than this, a temp manifest is a crashed write's, not one in flight in another process. */
const CRASHED_TEMP_AGE_MS = 60_000;

/** Remove temp manifests a write left behind when it died between writing and renaming
 *  them: only real files (lstat) named exactly like one and last written over a minute
 *  ago, so another process's write in flight is never touched. Never throws. */
function clearCrashedTempManifests(root: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!TEMP_MANIFEST_NAME.test(name)) continue;
    const temp = path.join(root, name);
    const stat = lstatOrNull(temp);
    if (!stat?.isFile() || now - stat.mtimeMs <= CRASHED_TEMP_AGE_MS) continue;
    try {
      fs.unlinkSync(temp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err: sanitizeErrForLog(err), tag: "skills", op: "temp_manifest_clear_failed" }, "skills.temp_manifest_clear_failed");
      }
    }
  }
}

function sameNames(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/** Names libi wrote into `root` per its manifest; `[]` when there is no readable manifest. */
export function managedSkillNames(root: string): string[] {
  return [...(readManagedNames(root) ?? [])].sort();
}

export interface SkillsWriteResult {
  writes: number;
  removed: number;
  /** Skills NOT written because an entry of that name (any case) existed and was not libi's. */
  skipped: string[];
}

/**
 * Write `skills` into one skills root (`<folder>/.claude/skills`, `~/.agents/skills`, …).
 *
 * `external: true` — a root outside libi's own agent dir. A skill whose name is not
 * a plain folder name, or with a supporting file whose path is not plain and
 * relative, is left out before anything is written (logged as a count). Only a REAL directory
 * whose exact name the manifest lists is libi's. Anything else sharing a skill's
 * name, compared case-insensitively (the default macOS and Windows filesystems
 * are) — a dir, a symlink live or dangling, a file — is someone else's: the
 * skill is skipped, reported, and kept out of the manifest, so the next run
 * skips it too. A listed name that is now a link or a file has stopped being
 * libi's and is dropped the same way. Orphans are removed only among real,
 * manifest-listed dirs. No legacy sweeps. A manifest that exists but cannot be
 * read or parsed throws before anything is written, with a short message saying
 * how to recover: treating it as absent would mark every skill libi wrote as
 * someone else's and stop updating them for good, while throwing leaves the root
 * as it is for the next sync to retry.
 *
 * `external: false` — libi's own agent dir, today's behaviour: a root that
 * predates the manifest is grandfathered (every non-enabled dir is libi's), and
 * a link or file where a skill belongs is replaced — the link itself, never
 * what it points at.
 *
 * A listed name that is no longer a real folder is dropped from the manifest
 * before any orphan is removed. Each orphan's name is dropped from the manifest
 * right after its dir is actually removed — not batched to the end — so a later
 * orphan's removal throwing never leaves an already-deleted one listed for a
 * user to trip over before the next run. Each skill's name is recorded in the
 * manifest immediately before its dir is written, so a throw part-way leaves
 * listed exactly the dirs libi already owned (minus orphans already removed)
 * plus the skills whose writing had started — never a skill it had not reached,
 * whose name a user folder could later take. The manifest ends up holding
 * exactly the names this call wrote.
 */
export function writeSkillsToRoot(root: string, allSkills: Skill[], opts: { external: boolean }): SkillsWriteResult {
  const skills = opts.external ? externallyWritableSkills(allSkills) : allSkills;
  fs.mkdirSync(root, { recursive: true });
  clearCrashedTempManifests(root);
  const read = readManifest(root, { warn: true });
  if (read === UNREADABLE_MANIFEST && opts.external) throw unreadableManifestError("write");
  const manifest = read === UNREADABLE_MANIFEST ? null : read;
  const entries = listRootEntries(root);
  const owned = new Set(
    entries
      .filter((e) => e.kind === "dir" && (manifest ? manifest.has(e.name) : !opts.external))
      .map((e) => e.name),
  );
  const requested = new Set(skills.map((s) => s.name));
  // An owned entry no skill asks for is an orphan about to be removed, so it
  // does not stand in the way of a skill whose name differs only in case.
  const blocks = (entry: RootEntry, skill: Skill): boolean =>
    entry.name.toLowerCase() === skill.name.toLowerCase() &&
    !(owned.has(entry.name) && (entry.name === skill.name || !requested.has(entry.name)));

  const skipped = opts.external
    ? skills.filter((s) => entries.some((e) => blocks(e, s))).map((s) => s.name).sort()
    : [];
  const skippedSet = new Set(skipped);
  const toWrite = skills.filter((s) => !skippedSet.has(s.name));
  const wanted = new Set(toWrite.map((s) => s.name));
  let writes = 0;
  let removed = 0;

  // A listed name that is no longer a real folder has stopped being libi's. It
  // leaves the manifest before anything is removed, so an orphan removal that
  // throws cannot leave it listed for a later run to trust.
  if (manifest && !sameNames(manifest, owned)) writeManagedNames(root, owned);

  // What the manifest must list if this call stops part-way: libi's dirs that
  // are still there, plus every skill whose writing has started.
  const recorded = new Set(owned);
  for (const name of owned) {
    if (wanted.has(name)) continue;
    if (removeRealDir(path.join(root, name))) {
      removed++;
      recorded.delete(name);
      writeManagedNames(root, recorded);
    } else {
      recorded.delete(name);
    }
  }

  for (const skill of toWrite) {
    const skillDir = path.join(root, skill.name);
    recorded.add(skill.name);
    writeManagedNames(root, recorded);
    // Only reachable in libi's own dir — an external root skipped these above.
    for (const entry of entries) {
      if (entry.kind !== "dir" && entry.name.toLowerCase() === skill.name.toLowerCase()) {
        fs.unlinkSync(path.join(root, entry.name));
      }
    }
    if (writeIfChanged(path.join(skillDir, "SKILL.md"), skill.body)) writes++;
    // Both sides spelled one way (`supportingFileKey`), so a file the skill still ships is never taken for an orphan.
    const desiredFiles = new Set(skill.supportingFiles.map((f) => supportingFileKey(f.relPath)));
    const walkExisting = (relRoot: string): void => {
      const abs = path.join(skillDir, relRoot);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = supportingFileKey(path.join(relRoot, entry.name));
        if (isRealDir(path.join(skillDir, rel))) {
          walkExisting(rel);
        } else if (rel !== "SKILL.md" && !desiredFiles.has(rel)) {
          fs.rmSync(path.join(skillDir, rel), { force: true });
          removed++;
        }
      }
    };
    walkExisting(".");
    for (const file of skill.supportingFiles) {
      if (writeIfChanged(supportingFilePath(skillDir, file.relPath), file.contents)) writes++;
    }
    pruneEmptyDirs(skillDir);
  }

  writeManagedNames(root, wanted);
  return { writes, removed, skipped };
}

/**
 * Remove from `root` only what its manifest says libi wrote, then the manifest,
 * then the root itself if nothing is left. Never the parent (`.claude`,
 * `.agents`, the folder), never a dir the manifest does not name, and never
 * through a link: a listed name that is now a symlink or a file stays, and so
 * does everything it points at. Without a manifest libi owns nothing there.
 *
 * `external: true` — a root outside libi's own agent dir: a manifest that exists
 * but cannot be read throws (the same recovery message as a write) instead of
 * removing nothing, so removing an install reports the failure rather than
 * forgetting the folders libi wrote. Default (`external` unset or false): an
 * unreadable manifest names nothing, so nothing is removed.
 *
 * A root that is not a real directory right now (by lstat) removes nothing: a
 * root that is itself a link would read the manifest at its target and delete
 * the dirs listed there, somewhere the caller never named. `rootMayBeLink` is
 * for an agent's user-level skills dir, which the user may have linked
 * themselves (a dotfiles setup): the agent reads skills through that link, so
 * libi's copy is written and removed through it too. The link itself is kept.
 */
export function removeSkillsFromRoot(
  root: string,
  opts: { external?: boolean; rootMayBeLink?: boolean } = {},
): { removed: number } {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return { removed: 0 };
  if (!rootStat.isDirectory() && !(opts.rootMayBeLink && rootStat.isSymbolicLink())) return { removed: 0 };
  const read = readManifest(root, { warn: true });
  if (read === UNREADABLE_MANIFEST && opts.external) throw unreadableManifestError("remove");
  const managed = read === UNREADABLE_MANIFEST ? null : read;
  if (!managed) return { removed: 0 };
  const removed = removeManagedDirs(root, managed);
  fs.rmSync(path.join(root, MANIFEST_FILE), { force: true });
  clearCrashedTempManifests(root);
  if (lstatOrNull(root)?.isDirectory() && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  return { removed };
}

/**
 * One-time sweep of a retired dialect skill dir (`.codex/skills`) libi used to
 * mirror to. Uses the SAME ownership rules as the live orphan cleanup: only
 * dirs listed in the dir's `.libi-managed.json` manifest are libi-owned and get
 * removed (along with the manifest itself); a user's own dir (never in the
 * manifest) is preserved. Without a manifest we own nothing here — a legacy
 * unmanaged `.codex/skills` is left untouched. If the dir ends up empty, it is
 * removed. Wrapped in try/catch so a sweep failure never breaks skill writing.
 */
export function sweepLegacyDialect(workspaceDir: string, dialect: string): void {
  const root = path.join(workspaceDir, dialect);
  try {
    if (!fs.existsSync(root)) return;
    const managed = readManagedNames(root, { warn: true });
    if (managed) {
      removeManagedDirs(root, managed);
      fs.rmSync(path.join(root, MANIFEST_FILE), { force: true });
    }
    // Remove the dialect dir (and its now-empty parent) if nothing remains.
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
      fs.rmdirSync(root);
      const parent = path.dirname(root);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    }
  } catch (err) {
    logger.warn(
      { err: sanitizeErrForLog(err), dialect, tag: "skills", op: "legacy_dialect_sweep_failed" },
      "skills.legacy_dialect_sweep_failed",
    );
  }
}

/**
 * Whether `target` is `root` or somewhere inside it, both absolute and resolved. Letter case is
 * ignored on win32 and darwin, whose default disks ignore it too. `platform` lets a test apply
 * another platform's rules.
 */
export function isSameOrInsidePath(target: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string): string => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const t = fold(target);
  const r = fold(root);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Where `p` really is: links resolved, in the on-disk letter case where the native call answers; `p` resolved when it does not exist. */
function realpathBestEffort(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
}

/** Where a root of libi's own agent dir was already reported reaching a user-level skills dir, so each is logged once. */
const reportedUserSkillsDirReaches = new Set<string>();

/**
 * Every protected root's realpath, resolved ONCE per sync (`writeSkillsToWorkspace` calls this
 * before its dialect loop) rather than once per dialect inside `reachesUserSkillsDir`. A root that
 * does not exist right now is left out entirely: nothing an existing link could resolve to is
 * there, so there is nothing to compare against, and trying anyway would pay the JS
 * `fs.realpathSync` fallback's per-component lstat walk for a path `realpathSync.native` has
 * already failed to resolve — the common case for an agent's user-level skills dir on a machine
 * that has never linked one. ENOENT is the only realistic failure; any other is treated the same
 * way, since a root libi cannot currently resolve cannot be compared against either.
 */
function resolveProtectedRoots(protectedRoots: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const p of protectedRoots) {
    try {
      resolved.push(fs.realpathSync.native(p));
    } catch {
      // Not there right now: skip it, rather than falling back to the JS walk.
    }
  }
  return resolved;
}

/**
 * Whether `root`, resolved, is or is inside one of `resolvedProtectedRoots` (already resolved,
 * once per sync, by `resolveProtectedRoots`). Logged once per place it reaches, with the dialect
 * only: the path is under the user's home.
 */
function reachesUserSkillsDir(root: string, dialect: string, resolvedProtectedRoots: readonly string[]): boolean {
  if (resolvedProtectedRoots.length === 0) return false;
  const real = realpathBestEffort(root);
  if (!resolvedProtectedRoots.some((p) => isSameOrInsidePath(real, p))) return false;
  if (!reportedUserSkillsDirReaches.has(real)) {
    reportedUserSkillsDirReaches.add(real);
    logger.warn({ tag: "skills", op: "own_agent_dir_linked_to_user_skills", dialect }, "skills.own_agent_dir_linked_to_user_skills");
  }
  return true;
}

/**
 * Write skills into a workspace's dialect roots (+ the legacy sweeps). Serves
 * libi's own agent dir — where it writes as the owner (`external: false`) —
 * and, until the CLI moves to the install service, a folder passed by
 * `libi connect`, which is written as an external root. `dialects` narrows the
 * set written (default: all of `SKILL_DIALECTS`); a dialect left out has libi's
 * copies removed from this workspace — used while the matching agent has a
 * user-level install, since libi's chat and terminal then already see those
 * skills through the user's own HOME / CLAUDE_CONFIG_DIR and a second copy of
 * every name would break explicit skill invocation. Skipped names are not
 * returned, only their count (logged on `workspace_written`); a caller that
 * needs the names themselves calls `writeSkillsToRoot` directly.
 *
 * `protectedRoots` — every agent's user-level skills dir, which only libi's own
 * agent dir consults. A dialect root of it that really is, or is inside, one of
 * them (a link at the root, at a parent, or a user-level dir linked to it) holds
 * what a user-level install and the user put there: it is written as an external
 * root and never removed from, or dropping the dialect would delete the install
 * that caused the drop, and every later write would repeat it.
 */
export async function writeSkillsToWorkspace(
  workspaceDir: string,
  enabledSkills: Skill[],
  opts: { dialects?: readonly string[]; protectedRoots?: readonly string[] } = {},
): Promise<void> {
  const dialects = opts.dialects ?? SKILL_DIALECTS;
  const ownedDefaultDir = path.resolve(workspaceDir) === path.resolve(getLibiAgentDir());
  const protectedRoots = ownedDefaultDir ? resolveProtectedRoots(opts.protectedRoots ?? []) : [];
  let writes = 0;
  let removed = 0;
  let skipped = 0;

  for (const dialect of SKILL_DIALECTS) {
    const root = path.join(workspaceDir, dialect);
    const userSkillsDir = reachesUserSkillsDir(root, dialect, protectedRoots);
    if (dialects.includes(dialect)) {
      const r = writeSkillsToRoot(root, enabledSkills, { external: !ownedDefaultDir || userSkillsDir });
      writes += r.writes;
      removed += r.removed;
      skipped += r.skipped.length;
    } else if (!userSkillsDir) {
      // libi owns its own agent dir's tree even when the user linked it (a dotfiles setup
      // sharing libi's skill files with their own tooling); a dropped dialect must still
      // lose libi's copy there, or the next Every-folder toggle leaves it doubled up.
      removed += removeSkillsFromRoot(root, { external: !ownedDefaultDir, rootMayBeLink: ownedDefaultDir }).removed;
    }
  }

  // One-time orphan sweep of the retired GEMINI.md inline artifact (Gemini CLI
  // is being removed). Idempotent — a second run finds the file gone.
  sweepLegacyGeminiFile(workspaceDir);

  // One-time sweep of the retired `.codex/skills` mirror — codex's real
  // discovery path is `.agents/skills`. Idempotent.
  sweepLegacyDialect(workspaceDir, LEGACY_CODEX_DIALECT);

  // `skipped` is a bounded count only — never the names or paths behind it; a skip through a
  // protected link (writing libi's own agent dir as external) had no other breadcrumb.
  logger.info(
    { writes, removed, skipped, enabled: enabledSkills.length, dialects, tag: "skills", op: "workspace_written" },
    "skills.workspace_written",
  );
}
