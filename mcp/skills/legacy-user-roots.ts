import fs from "node:fs";
import path from "node:path";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { AGENT_SKILL_TARGETS } from "@/lib/agents/skill-targets";
import { serverLogger as logger } from "@/lib/logger";
import type { Skill } from "./types";
import { managedSkillNames, sanitizeErrForLog, writeSkillsToRoot } from "./writer";

/*
 * User-level skills roots libi wrote that no install row records.
 *
 * An install row (`skill_installs`, mcp/skills/installs.ts) is what makes a copy updatable: every
 * boot and every skill change rewrites the recorded roots. Rows arrived with the HTTP `libi connect`
 * on 2026-09-18. Before that, `libi connect --connect-agent` wrote `~/.agents/skills` (and
 * `~/.claude/skills`) with a `.libi-managed.json` manifest and recorded nothing, so nothing ever
 * rewrote those copies again: in-app Codex kept reading a 2026-09-12 mirror that still carried
 * retired skills and old tool names, next to the current set.
 *
 * The manifest is the proof libi wrote there, and `writeSkillsToRoot(..., { external: true })` already
 * refreshes only what the manifest lists (rewrites changed skills, removes listed ones that are
 * gone, skips a folder libi did not write). This only decides WHICH roots get that treatment.
 */

/** What a refresh pass did, for the log line and for tests. */
export interface LegacyRootsResult {
  roots: number;
  writes: number;
  removed: number;
  skipped: number;
  failed: number;
}

export interface LegacyRootsOptions {
  /** Agents that have a recorded user-level install: their root is the install's, not ours. */
  recordedAgents: ReadonlySet<SetupAgentId>;
  env: NodeJS.ProcessEnv;
  homedir: string;
  libiHome: string;
  /** Whether a root, resolved, is libi's own agent dir or inside it (the install service's check). */
  linkedToLibiAgentDir: (root: string) => boolean;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isInside(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Whether this process's LIBI_HOME is a home that owns the user's own skills roots.
 *
 * A recorded row is hermetic by construction (the DB lives under LIBI_HOME); a manifest on disk is
 * not, so without this a throwaway home would rewrite the real `~/.agents/skills`: the vitest run
 * (LIBI_HOME in the OS temp dir), a skill-eval run (same), and a dev worktree
 * (`~/.libi/worktrees/<name>`, whose skills may be older or newer than the user's installed libi).
 * Only a home inside the user's home that is not a worktree's refreshes them.
 */
export function homeMayRefreshUserRoots(libiHome: string, homedir: string): boolean {
  if (!isInside(libiHome, homedir)) return false;
  return !isInside(libiHome, path.join(homedir, ".libi", "worktrees"));
}

/**
 * The user-level roots to refresh: an agent without a recorded user-level install whose root is a
 * real directory (never a link: nothing is written through one) holding a readable manifest that
 * still lists at least one skill folder that exists (a manifest whose folders the user deleted by
 * hand is not a reason to put them back).
 */
export function legacyUserRoots(opts: LegacyRootsOptions): { agentId: SetupAgentId; root: string }[] {
  if (!homeMayRefreshUserRoots(opts.libiHome, opts.homedir)) return [];
  const found: { agentId: SetupAgentId; root: string }[] = [];
  const seen = new Set<string>();
  for (const target of AGENT_SKILL_TARGETS) {
    if (opts.recordedAgents.has(target.agentId)) continue;
    const root = target.userSkillsDir(opts.env, opts.homedir);
    if (seen.has(root)) continue;
    if (!lstatOrNull(root)?.isDirectory()) continue;
    const names = managedSkillNames(root);
    if (!names.some((name) => lstatOrNull(path.join(root, name))?.isDirectory())) continue;
    if (opts.linkedToLibiAgentDir(root)) continue;
    seen.add(root);
    found.push({ agentId: target.agentId, root });
  }
  return found;
}

/**
 * Refresh each root from the current skill set and log what it did. A root that fails is logged
 * and left as it was (the next boot or skill change retries); nothing here throws.
 */
export function refreshLegacyUserRoots(
  skills: Skill[],
  roots: readonly { agentId: SetupAgentId; root: string }[],
  reason: string,
): LegacyRootsResult {
  const result: LegacyRootsResult = { roots: roots.length, writes: 0, removed: 0, skipped: 0, failed: 0 };
  for (const { agentId, root } of roots) {
    try {
      const r = writeSkillsToRoot(root, skills, { external: true });
      result.writes += r.writes;
      result.removed += r.removed;
      result.skipped += r.skipped.length;
    } catch (err) {
      result.failed++;
      logger.warn(
        { err: sanitizeErrForLog(err), tag: "skills", op: "legacy_user_root_failed", agentId, reason },
        "skills.legacy_user_root_failed",
      );
    }
  }
  if (result.writes > 0 || result.removed > 0 || result.failed > 0) {
    logger.info({ tag: "skills", op: "legacy_user_roots_refreshed", reason, ...result }, "skills.legacy_user_roots_refreshed");
  }
  return result;
}
