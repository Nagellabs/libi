/**
 * Vitest global setup: point LIBI_HOME at a per-vitest-run temp directory
 * so tests can never touch the real `~/.libi/` — no DB, no logs, no agent
 * workspace files.
 *
 * Isolation now rides entirely on LIBI_HOME. The default agent dir
 * (`getLibiAgentDir()`) derives from it as `<LIBI_HOME>/agent/`, so there
 * is no need for a separate workspace-dir env var. LIBI_CONNECT_AGENT_DIR
 * is never set globally here — tests that exercise connect-agent behavior
 * set it themselves within their own beforeEach/afterEach.
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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempRoot: string | null = null;

export async function setup(): Promise<void> {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-vitest-"));
  fs.mkdirSync(path.join(tempRoot, "agent"), { recursive: true });

  process.env.LIBI_HOME = tempRoot;
}

export async function teardown(): Promise<void> {
  if (tempRoot) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    tempRoot = null;
  }
}
