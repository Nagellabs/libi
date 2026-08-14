import { getLibiAgentDir } from "@/lib/libi-home";
import { TerminalManager } from "./manager";
import { realPtyFactory } from "./pty";

/**
 * globalThis singleton — in `next dev`, route-handler modules are
 * re-evaluated on edit; a module-level instance would be silently
 * replaced, orphaning live PTYs (same class of bug as the SessionManager
 * / JobManager singletons guard against).
 *
 * PTYs spawn rooted at the agent workspace (`~/.libi/agent/`), which
 * already holds CLAUDE.md / AGENTS.md / .claude/settings.local.json — so
 * any CLI launched in a terminal discovers libi's MCP tools exactly like
 * the documented "Bring Your Own CLI" mode.
 */
const g = globalThis as unknown as { __libiTerminalManager?: TerminalManager };

export function getTerminalManager(): TerminalManager {
  if (!g.__libiTerminalManager) {
    g.__libiTerminalManager = new TerminalManager(realPtyFactory, {
      cwd: () => getLibiAgentDir(),
    });
  }
  return g.__libiTerminalManager;
}
