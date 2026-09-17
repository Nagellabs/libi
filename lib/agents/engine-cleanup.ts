import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { getAgentInstallRoot } from "@/lib/agents/adapter-tree";

/**
 * Idempotent deletion of the engine packages an older libi downloaded into
 * `~/.libi/agents`. The chat runs the user's own CLI now, so
 * `@anthropic-ai/claude-agent-sdk-<platform>` (~306 MB) and
 * `@openai/codex-<platform>` (~271 MB) are dead weight — and the adapters are
 * installed with `--omit=optional`, so nothing brings them back. The adapters
 * and their JS launchers (`@anthropic-ai/claude-agent-sdk`, `@openai/codex`)
 * stay.
 *
 * Runs on every boot (Category B); a tree with nothing to delete costs a few
 * failed `lstat`s. It never follows a symlink: a scope dir, an engine dir, or
 * any directory between the agent root and them that is a link is skipped and
 * its bytes are not counted, so a linked local build is never deleted through
 * the agent root.
 */

/**
 * EXACTLY the platform packages — a prefix match like `codex-` would also
 * delete a future `@openai/codex-sdk` on every boot.
 */
const ENGINE_NAME: Record<string, RegExp> = {
  "@anthropic-ai": /^claude-agent-sdk-(darwin|linux|win32)-(x64|arm64)(-musl)?$/,
  "@openai": /^codex-(darwin|linux|win32)-(x64|arm64)$/,
};
const SCOPES = Object.keys(ENGINE_NAME);

/** Every `node_modules/<scope>` dir npm could have put a platform package in. */
export function enginePackageDirs(root: string): string[] {
  const top = path.join(root, "node_modules");
  const nested = [
    path.join(top, "@agentclientprotocol", "claude-agent-acp", "node_modules"),
    path.join(top, "@anthropic-ai", "claude-agent-sdk", "node_modules"),
    path.join(top, "@agentclientprotocol", "codex-acp", "node_modules"),
    path.join(top, "@openai", "codex", "node_modules"),
  ];
  return [top, ...nested].flatMap((nm) => SCOPES.map((scope) => path.join(nm, scope)));
}

/**
 * True when every path component below `root`, down to and including `dir`,
 * is a real directory — never a symlink (`lstat` does not follow one).
 */
function realDirBelow(root: string, dir: string): boolean {
  let current = root;
  for (const segment of path.relative(root, dir).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (!fs.lstatSync(current).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Apparent size of the regular files under `dir`; symlinks are neither followed nor counted. */
function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += fs.lstatSync(p).size;
  }
  return total;
}

export function cleanupEnginePackages(root: string = getAgentInstallRoot()): { removed: number; bytesFreed: number } {
  let removed = 0;
  let bytesFreed = 0;
  for (const scopeDir of enginePackageDirs(root)) {
    const pattern = ENGINE_NAME[path.basename(scopeDir)];
    if (!pattern || !realDirBelow(root, scopeDir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(scopeDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!pattern.test(name)) continue;
      const target = path.join(scopeDir, name);
      if (!realDirBelow(scopeDir, target)) continue;
      try {
        const bytes = dirBytes(target);
        fs.rmSync(target, { recursive: true, force: true });
        bytesFreed += bytes;
        removed++;
      } catch (err) {
        logger.warn({ tag: "agent-install", op: "engine_cleanup_failed", target, err }, "could not delete an engine package");
      }
    }
  }
  if (removed > 0) {
    logger.info({ tag: "agent-install", op: "engine_cleanup", root, removed, bytesFreed }, "deleted downloaded agent engines");
  }
  return { removed, bytesFreed };
}
