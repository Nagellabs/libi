import fs from "fs";
import os from "os";
import path from "path";
import { getLibiHome } from "@/lib/libi-home";
import { isTestMode } from "@/lib/test-mode";

/**
 * The Codex home libi reads/writes for THIS instance.
 *
 * Resolution order:
 *   1. Explicit `CODEX_HOME` env — always wins (mirrors Codex CLI's own rule).
 *   2. Test mode (`LIBI_TEST_MODE=1`, which every skill-eval run sets) → a home
 *      scoped under the libi home, `<LIBI_HOME>/.codex`, so fake providers and
 *      eval agents never read or write the user's real Codex config.
 *   3. Everything else — the installed app, `npx`, a dev checkout or a git
 *      worktree → the user's real `~/.codex`.
 *
 * A worktree used to get the scoped home too, which made its Global Codex
 * configuration invisible to the user's own Codex app and CLI: `codex mcp add`
 * submitted in its setup terminal landed in `<worktree home>/.codex`, which only
 * libi read. Claude Code has always used the user's real `~/.claude.json` from a
 * worktree, so both agents now behave the same. libi still never writes the file
 * itself — every change is a `codex` command the user submits.
 *
 * Reads `process.env` fresh on every call (via `getLibiHome()` / `isTestMode()`),
 * so tests can vary the environment without rebuilding modules.
 */
export function resolveCodexHome(): string {
  const explicit = process.env.CODEX_HOME;
  if (explicit) return explicit;
  if (isTestMode()) return path.join(getLibiHome(), ".codex");
  return path.join(os.homedir(), ".codex");
}

/**
 * Resolve the codex home AND make sure the directory exists.
 *
 * Handing `CODEX_HOME` to a process that then finds nothing there is not a
 * no-op — codex REFUSES TO START:
 *
 *     Error: CODEX_HOME points to "…/.codex", but that path does not exist
 *
 * (observed directly: the ACP child exited 1 on a scoped home, 2026-08-16).
 * So every place that sets the variable must also guarantee the directory —
 * the ACP child (lib/agents/process-manager.ts), the terminal PTY
 * (lib/terminal/manager.ts, which sets it for EVERY preset because a setup
 * terminal types `codex` commands into a plain shell).
 *
 * Best-effort by design: a failure here is never worth blocking a spawn over,
 * and whatever codex does next reports the real error.
 */
export function ensureCodexHome(): string {
  const home = resolveCodexHome();
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch {
    // ignore — surfaced downstream by codex itself if it matters
  }
  return home;
}
