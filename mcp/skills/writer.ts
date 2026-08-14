import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiAgentDir } from "@/lib/libi-home";
import type { Skill } from "./types";

const DIALECTS = [".claude/skills", ".agents/skills"];

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

function writeIfChanged(absPath: string, contents: string | Buffer): boolean {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (fs.existsSync(absPath)) {
    const existing = fs.readFileSync(absPath);
    const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (sha(existing) === sha(next)) return false;
  }
  fs.writeFileSync(absPath, contents);
  return true;
}

function listSubdirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function pruneEmptyDirs(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const childPath = path.join(root, entry.name);
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
    logger.warn({ err, workspaceDir, tag: "skills", op: "gemini_sweep_failed" }, "gemini.sweep_failed");
  }
}

const MANIFEST_FILE = ".libi-managed.json";

/** Names of skill dirs libi wrote previously; null when no manifest exists. */
function readManagedNames(root: string): Set<string> | null {
  const p = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (parsed && Array.isArray(parsed.managed)) {
      return new Set(parsed.managed.filter((n: unknown): n is string => typeof n === "string"));
    }
  } catch {
    // malformed → treat as absent (manage only what we create from now on)
  }
  return null;
}

function writeManagedNames(root: string, names: Set<string>): void {
  // writeIfChanged keeps the manifest on the file's write-only-on-change
  // discipline — no spurious rewrite when the enabled set is unchanged.
  writeIfChanged(
    path.join(root, MANIFEST_FILE),
    JSON.stringify({ managed: [...names].sort() }, null, 2) + "\n",
  );
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
    const managed = readManagedNames(root);
    if (managed) {
      for (const name of managed) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
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
      { err, workspaceDir, dialect, tag: "skills", op: "legacy_dialect_sweep_failed" },
      "skills.legacy_dialect_sweep_failed",
    );
  }
}

export async function writeSkillsToWorkspace(workspaceDir: string, enabledSkills: Skill[]): Promise<void> {
  const enabledNames = new Set(enabledSkills.map((s) => s.name));
  let writes = 0;
  let removed = 0;

  const ownedDefaultDir =
    path.resolve(workspaceDir) === path.resolve(getLibiAgentDir());

  for (const dialect of DIALECTS) {
    const root = path.join(workspaceDir, dialect);
    fs.mkdirSync(root, { recursive: true });

    // Orphan cleanup only touches dirs libi owns: those in the manifest, or
    // (grandfathering, pre-manifest installs) everything when this is the
    // default agent dir. A user's own skill dir in a connected workspace is
    // never in either set and is never deleted.
    const manifest = readManagedNames(root);
    const removable =
      manifest ?? (ownedDefaultDir ? new Set(listSubdirs(root)) : new Set<string>());
    for (const existing of listSubdirs(root)) {
      if (!enabledNames.has(existing) && removable.has(existing)) {
        fs.rmSync(path.join(root, existing), { recursive: true, force: true });
        removed++;
      }
    }

    for (const skill of enabledSkills) {
      const skillDir = path.join(root, skill.name);
      if (writeIfChanged(path.join(skillDir, "SKILL.md"), skill.body)) writes++;
      const desiredFiles = new Set(skill.supportingFiles.map((f) => f.relPath));
      const walkExisting = (relRoot: string): void => {
        const abs = path.join(skillDir, relRoot);
        if (!fs.existsSync(abs)) return;
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
          const rel = path.join(relRoot, entry.name);
          if (entry.isDirectory()) {
            walkExisting(rel);
          } else if (rel !== "SKILL.md" && !desiredFiles.has(rel)) {
            fs.rmSync(path.join(skillDir, rel), { force: true });
            removed++;
          }
        }
      };
      walkExisting(".");
      for (const file of skill.supportingFiles) {
        if (writeIfChanged(path.join(skillDir, file.relPath), file.contents)) writes++;
      }
      pruneEmptyDirs(skillDir);
    }

    writeManagedNames(root, enabledNames);
  }

  // One-time orphan sweep of the retired GEMINI.md inline artifact (Gemini CLI
  // is being removed). Covers the default agent dir and any connected dir on
  // its next regen. Idempotent — a second run finds the file gone.
  sweepLegacyGeminiFile(workspaceDir);

  // One-time sweep of the retired `.codex/skills` mirror — codex's real
  // discovery path is `.agents/skills` (now a DIALECT above). Idempotent — a
  // second run finds the dir gone.
  sweepLegacyDialect(workspaceDir, LEGACY_CODEX_DIALECT);

  logger.info({ writes, removed, enabled: enabledSkills.length }, "skills.workspace_written");
}
