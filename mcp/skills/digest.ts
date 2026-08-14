import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import pkg from "@/package.json";
import { getBundledSkillsDir } from "@/lib/libi-home";
import { getSkillDigestCacheSetting, setSkillDigestCacheSetting } from "@/lib/db/settings";
import { BUNDLED_SKILLS } from "./registry";

/** Walk a skill folder and return sorted relative file paths. Symlinks are
 *  skipped — same policy as the loader's readSupportingFiles. */
function walkFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(rootDir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(".");
  return out.sort();
}

/** sha256 over every file in the skill folder: relPath + NUL + bytes + NUL,
 *  in sorted relPath order. Deterministic across machines. */
export function computeSkillDirDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const relPath of walkFiles(dir)) {
    hash.update(relPath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dir, relPath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Relative paths that differ between two skill folders (modified, added,
 *  or removed), comparing file bytes. */
export function listChangedFiles(baseDir: string, currentDir: string): string[] {
  const baseFiles = fs.existsSync(baseDir) ? walkFiles(baseDir) : [];
  const currentFiles = fs.existsSync(currentDir) ? walkFiles(currentDir) : [];
  const all = new Set([...baseFiles, ...currentFiles]);
  const changed: string[] = [];
  for (const rel of all) {
    const a = path.join(baseDir, rel);
    const b = path.join(currentDir, rel);
    if (!fs.existsSync(a) || !fs.existsSync(b)) {
      changed.push(rel);
      continue;
    }
    if (!fs.readFileSync(a).equals(fs.readFileSync(b))) changed.push(rel);
  }
  return changed;
}

export interface SkillDigestCache {
  version: string;
  digests: Record<string, string>;
}

let memo: SkillDigestCache | null = null;

/** Test-only: clear the in-process memo. */
export function __resetDigestMemoForTests(): void {
  memo = null;
}

/**
 * Digest of every bundled skill folder, keyed by skill name.
 *
 * Installed builds: cached in the settings table keyed by app version — one
 * lazy sweep per version change, then free. Dev/test builds bypass the cache
 * entirely (skills change on disk without a version bump, so a version-keyed
 * cache would lie) and recompute per call (~25 markdown folders, milliseconds).
 */
export function getBundledSkillDigests(
  opts: { version?: string; bypassCache?: boolean } = {},
): Record<string, string> {
  const version = opts.version ?? (pkg as { version: string }).version;
  const bypass = opts.bypassCache ?? process.env.NODE_ENV !== "production";

  if (!bypass) {
    if (memo?.version === version) return memo.digests;
    const stored = getSkillDigestCacheSetting();
    if (stored?.version === version) {
      memo = stored;
      return stored.digests;
    }
  }

  const digests: Record<string, string> = {};
  const root = getBundledSkillsDir();
  for (const def of BUNDLED_SKILLS) {
    const dir = path.join(root, def.name);
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      digests[def.name] = computeSkillDirDigest(dir);
    }
  }

  if (!bypass) {
    memo = { version, digests };
    setSkillDigestCacheSetting(memo);
  }
  return digests;
}
