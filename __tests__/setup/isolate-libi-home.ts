/**
 * Vitest global setup: point LIBI_HOME at a per-vitest-run temp directory
 * so tests can never touch the real `~/.libi/` — no DB, no logs, no agent
 * workspace files.
 *
 * Isolation rides entirely on LIBI_HOME. The default agent dir
 * (`getLibiAgentDir()`) derives from it as `<LIBI_HOME>/agent/`, so there
 * is no separate workspace-dir env var to isolate — the per-folder agent
 * directory a CLI used to be pointed at no longer exists.
 *
 * Without this, tests that import code which reaches for
 * `~/.libi/agent/.claude/settings.local.json` (via `invalidateMcpConfig`,
 * `prepareAgentDir`, etc.) silently corrupt the user's real agent
 * workspace. That bit us with the YouTube Downloader MCP disappearing
 * from the BYO-CLI settings file mid-session.
 *
 * Individual tests that need their own LIBI_HOME (e.g. libi-home.test.ts)
 * can still override `process.env.LIBI_HOME` inside `beforeEach` — this
 * setup just establishes a safe default for everyone else.
 *
 * `bin/` is populated rather than left empty — see
 * `__tests__/helpers/provisioned-bin.ts` for why an empty one silently
 * substituted a different ffmpeg for the one libi ships.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkProvisionedBinaries } from "../helpers/provisioned-bin";

let tempRoot: string | null = null;

export async function setup(): Promise<void> {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-vitest-"));
  fs.mkdirSync(path.join(tempRoot, "agent"), { recursive: true });
  linkProvisionedBinaries(tempRoot);

  process.env.LIBI_HOME = tempRoot;

  // The Codex home too: outside test mode `resolveCodexHome()` names the user's
  // real `~/.codex`, so a test that reaches a codex spawn or a config backup
  // without naming a home of its own must land here instead. Tests that clear
  // CODEX_HOME on purpose stub HOME to a scratch dir as well.
  const codexHome = path.join(tempRoot, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
}

export async function teardown(): Promise<void> {
  if (tempRoot) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    tempRoot = null;
  }
}
