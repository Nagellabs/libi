import os from "os";
import path from "path";
import { getLibiHome } from "@/lib/libi-home";
import { isTestMode } from "@/lib/test-mode";

/**
 * Canonical-instance guard for GLOBAL Codex config writes.
 *
 * A worktree / dev / skill-eval / test-mode instance must NEVER write the
 * user's real `~/.codex`. This module is a pure predicate — it performs no
 * filesystem writes itself. The sync layer consumes these helpers to decide
 * whether it is safe to touch the global Codex home.
 *
 * All checks read `process.env` fresh on every call (via `getLibiHome()` /
 * `isTestMode()`), so tests can vary the environment without rebuilding modules.
 */

/**
 * True only for the ONE canonical libi instance the user actually runs:
 * `getLibiHome()` resolves to the default `~/.libi` AND test mode is off.
 *
 * Worktrees set `LIBI_HOME` under `~/.libi/worktrees/<name>`, skill-eval sets
 * it to a temp dir, and test mode sets `LIBI_TEST_MODE=1` — all of which are
 * NON-canonical and must be blocked from global Codex writes.
 */
export function isCanonicalLibiInstance(): boolean {
  if (isTestMode()) return false;
  const defaultHome = path.join(os.homedir(), ".libi");
  return getLibiHome() === defaultHome;
}

/**
 * The Codex home libi reads/writes for THIS instance.
 *
 * Resolution order:
 *   1. Explicit `CODEX_HOME` env — always wins (mirrors Codex CLI's own rule).
 *   2. Canonical instance → the user's real `~/.codex`.
 *   3. Any non-canonical instance (worktree / dev / skill-eval / test mode) →
 *      a home SCOPED under the libi home (`<LIBI_HOME>/.codex`).
 *
 * This makes worktree-safety STRUCTURAL rather than a hard block: a
 * non-canonical instance can never resolve to the user's real `~/.codex`, so
 * the same Install/sync code path is free to run everywhere — a worktree just
 * writes its own scoped codex home. The terminal PTY spawns codex with this
 * `CODEX_HOME` too, so a worktree's built-in Terminal reads the config it wrote.
 */
export function resolveCodexHome(): string {
  const explicit = process.env.CODEX_HOME;
  if (explicit) return explicit;
  if (isCanonicalLibiInstance()) return path.join(os.homedir(), ".codex");
  return path.join(getLibiHome(), ".codex");
}
