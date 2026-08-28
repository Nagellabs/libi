/**
 * GitHub URL parsing + tarball fetch + candidate detection.
 *
 * The detector inspects an extracted repo root and decides which install
 * path the caller should take. Three positive shapes + one fallback:
 *
 *   1. `.claude-plugin/plugin.json`         → claude-plugin
 *   2. `SKILL.md` at root                   → single-skill
 *   3. `skills/<name>/SKILL.md`             → multi-skill (UI picks)
 *   4. otherwise                            → unknown (hand off to agent)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import type {
  ClaudePluginManifest,
  GithubRepoRef,
  InstallCandidate,
} from "./types";

const execFileAsync = promisify(execFile);

/**
 * Parse a GitHub URL into an owner/repo/ref/subPath.
 *
 * Supported shapes:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo/
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo/tree/<ref>
 *   - https://github.com/owner/repo/tree/<ref>/sub/path
 *   - https://github.com/owner/repo/blob/<ref>/sub/path     (treated like tree)
 *   - git@github.com:owner/repo.git
 *
 * Returns null on anything we can't confidently parse.
 */
export function parseGithubUrl(url: string): GithubRepoRef | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // git@github.com:owner/repo(.git)
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Reject anything that isn't https://github.com/...
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;

  // Strip leading slash, trailing slash, .git suffix
  const segments = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) return null;

  const owner = segments[0];
  let repo = segments[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!owner || !repo) return null;

  const ref: GithubRepoRef = { owner, repo };

  // .../tree/<ref>/... or .../blob/<ref>/...
  if (segments.length >= 4 && (segments[2] === "tree" || segments[2] === "blob")) {
    ref.ref = segments[3];
    if (segments.length > 4) {
      ref.subPath = segments.slice(4).join("/");
    }
  }

  return ref;
}

/**
 * Strict-mode `tar` resolution: avoid silently no-op'ing if tar is
 * missing. macOS + Linux ship with tar. Windows is not supported by
 * this code path; callers should already be on a Unix host.
 */
async function ensureTarAvailable(): Promise<void> {
  try {
    await execFileAsync("tar", ["--version"], { timeout: 5_000, windowsHide: true });
  } catch (err) {
    throw new Error(
      `tar is required to extract the GitHub tarball but was not found on PATH: ${(err as Error).message}`,
    );
  }
}

/**
 * Sanity check that an extracted tarball produced exactly one top-level
 * directory (GitHub tarballs nest under `<repo>-<sha>/`).
 */
async function findRepoRootInside(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) {
    throw new Error(
      `Expected exactly one top-level directory after tarball extract, got ${dirs.length}`,
    );
  }
  return path.join(dir, dirs[0].name);
}

/**
 * Download the repo tarball and extract it under `${LIBI_HOME}/tmp/`.
 * Returns the path the caller should detect against (root + optional subPath).
 *
 * Bounded to `${LIBI_HOME}/tmp/install-<random>/` so there's no way for
 * a malicious `subPath` to escape via traversal.
 */
export async function fetchRepoTarball(
  ref: GithubRepoRef,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ basePath: string }> {
  await ensureTarAvailable();

  const tmpRoot = path.join(getLibiHome(), "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });
  const installRoot = path.join(tmpRoot, `install-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(installRoot, { recursive: true });

  // codeload supports both "main" and explicit refs; if no ref is
  // specified we try `main` first then `master`.
  const candidateRefs = ref.ref ? [ref.ref] : ["main", "master"];
  const fetchFn = opts.fetchImpl ?? fetch;

  let lastError: Error | null = null;
  let extractedRoot: string | null = null;

  for (const candidate of candidateRefs) {
    const tarUrl = `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${candidate}`;
    const tarballPath = path.join(installRoot, "repo.tar.gz");
    logger.info(
      { tag: "install-from-url", op: "fetch_tarball_start", url: tarUrl },
      "Fetching repo tarball",
    );

    try {
      const resp = await fetchFn(tarUrl);
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status} ${resp.statusText} from ${tarUrl}`);
        // Only fall through to the next candidate ref on 404 (branch may not
        // exist). Other non-OK statuses (auth, rate limit, server error) are
        // not made better by trying another branch — surface them.
        if (resp.status === 404) continue;
        break;
      }
      if (!resp.body) {
        lastError = new Error(`Empty response body from ${tarUrl}`);
        break;
      }

      // Stream to disk to avoid buffering large repos in memory.
      const writeStream = createWriteStream(tarballPath);
      // resp.body is a web ReadableStream — convert to a node stream.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeline(Readable.fromWeb(resp.body as any), writeStream);
    } catch (err) {
      lastError = err as Error;
      break;
    }

    // Extract
    try {
      await execFileAsync("tar", ["-xzf", tarballPath, "-C", installRoot], {
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      lastError = new Error(`tar extract failed: ${(err as Error).message}`);
      continue;
    }

    // Remove tarball so findRepoRootInside sees only the extracted dir
    await fs.unlink(tarballPath).catch(() => {});
    extractedRoot = await findRepoRootInside(installRoot);
    break;
  }

  if (!extractedRoot) {
    // Cleanup the empty install dir
    await fs.rm(installRoot, { recursive: true, force: true }).catch(() => {});
    throw lastError ?? new Error("Failed to download tarball with no error captured");
  }

  // Apply subPath. Constrain to the extracted root to defeat traversal.
  let basePath = extractedRoot;
  if (ref.subPath) {
    const normalized = path
      .normalize(ref.subPath)
      .replace(/^[/\\]+/, "")
      .replace(/[/\\]+$/, "");
    const candidate = path.resolve(extractedRoot, normalized);
    if (!candidate.startsWith(extractedRoot + path.sep) && candidate !== extractedRoot) {
      throw new Error(`subPath escapes repo root: ${ref.subPath}`);
    }
    basePath = candidate;
  }

  logger.info(
    { tag: "install-from-url", op: "fetch_tarball_done", basePath },
    "Repo tarball extracted",
  );
  return { basePath };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Walk `<basePath>/skills` one level deep, collecting any directory
 * that contains a `SKILL.md`.
 */
export async function collectMultiSkill(
  basePath: string,
): Promise<Array<{ name: string; relPath: string }>> {
  const skillsDir = path.join(basePath, "skills");
  if (!(await pathExists(skillsDir))) return [];

  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const out: Array<{ name: string; relPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!(await pathExists(skillFile))) continue;
    let name = entry.name;
    try {
      const body = await fs.readFile(skillFile, "utf-8");
      const parsed = parseSkillBody(body);
      name = parsed.frontmatter.name;
    } catch {
      // Fall back to the directory name if frontmatter is malformed —
      // the install path will error loudly later with a useful message.
    }
    out.push({ name, relPath: path.posix.join("skills", entry.name) });
  }
  return out;
}

/**
 * Inspect an extracted repo root and classify it.
 */
export async function detectCandidate(basePath: string): Promise<InstallCandidate> {
  // 1. Claude plugin manifest
  const manifestPath = path.join(basePath, ".claude-plugin", "plugin.json");
  if (await pathExists(manifestPath)) {
    try {
      const manifest = await readJsonFile<ClaudePluginManifest>(manifestPath);
      if (!manifest.name || typeof manifest.name !== "string") {
        return {
          kind: "unknown",
          basePath,
          reason: "plugin.json missing required string field 'name'",
        };
      }
      return { kind: "claude-plugin", basePath, manifest };
    } catch (err) {
      return {
        kind: "unknown",
        basePath,
        reason: `failed to parse .claude-plugin/plugin.json: ${(err as Error).message}`,
      };
    }
  }

  // 2. Single skill at root
  const rootSkill = path.join(basePath, "SKILL.md");
  if (await pathExists(rootSkill)) {
    try {
      const body = await fs.readFile(rootSkill, "utf-8");
      const parsed = parseSkillBody(body);
      return {
        kind: "single-skill",
        basePath,
        skillPath: ".",
        name: parsed.frontmatter.name,
      };
    } catch (err) {
      return {
        kind: "unknown",
        basePath,
        reason: `SKILL.md is invalid: ${(err as Error).message}`,
      };
    }
  }

  // 3. Multi-skill repo
  const multi = await collectMultiSkill(basePath);
  if (multi.length > 0) {
    return { kind: "multi-skill", basePath, skills: multi };
  }

  // 4. Nothing recognizable
  return {
    kind: "unknown",
    basePath,
    reason: "no SKILL.md or plugin.json found",
  };
}

/**
 * Best-effort recursive removal. Swallows errors — the caller is in a
 * `finally` block and the temp tree is bounded under `${LIBI_HOME}/tmp/`.
 */
export async function cleanupBasePath(basePath: string): Promise<void> {
  // Walk up to the `install-<hex>` ancestor (so we don't leave the
  // randomized parent behind even when subPath was applied).
  const tmpRoot = path.join(getLibiHome(), "tmp");
  let toRemove = basePath;
  while (
    toRemove.startsWith(tmpRoot + path.sep) &&
    !path.basename(toRemove).startsWith("install-")
  ) {
    toRemove = path.dirname(toRemove);
  }
  if (!toRemove.startsWith(tmpRoot + path.sep)) {
    logger.warn(
      { tag: "install-from-url", op: "cleanup_skipped", basePath },
      "Refusing to clean a path outside LIBI_HOME/tmp",
    );
    return;
  }
  await fs.rm(toRemove, { recursive: true, force: true }).catch((err) => {
    logger.warn(
      { tag: "install-from-url", op: "cleanup_error", path: toRemove, err },
      "cleanupBasePath failed",
    );
  });
}
