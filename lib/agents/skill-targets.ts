import path from "node:path";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

/**
 * Where each of the user's OWN agents discovers skills. libi's own agent dir
 * (`<LIBI_HOME>/agent`) keeps writing both project dialects; these describe
 * the copies libi installs OUTSIDE it — in a project folder (the dialect,
 * relative to the folder) or for every folder (the agent's user-level dir).
 * Adding an agent is one more entry here.
 */
export interface AgentSkillTarget {
  agentId: SetupAgentId;
  name: string;
  /** Skills root relative to a project folder. */
  projectDialect: string;
  /** The agent's user-level skills dir, absolute. */
  userSkillsDir(env: NodeJS.ProcessEnv, homedir: string): string;
  /** The default user-level dir as copy names it. Use `displayUserSkillsDir` when the env may move it. */
  userSkillsDisplay: string;
}

/**
 * Claude Code reads personal skills from `${CLAUDE_CONFIG_DIR ?? ~/.claude}/skills`,
 * NFC-normalised exactly as its own config-dir helper does; an empty variable
 * counts as unset. Measured against Claude Code 2.1.245 (its debug log prints
 * `Loading skills from: … user=<CLAUDE_CONFIG_DIR>/skills`).
 *
 * A relative value is resolved against the home dir, not the cwd. libi resolves
 * this root in several processes whose cwds differ (the studio server, the MCP
 * child spawned with the agent workspace as cwd, `libi connect` in whatever
 * folder the user ran it from), and the root each one records is where a later
 * write or removal looks. Against the cwd, the same variable named a different
 * root in each process, and libi's copy moved between them on every sync. A
 * relative value is a misconfiguration; libi's aim here is one stable root,
 * which may not be the one Claude Code itself resolves.
 */
function claudeUserSkillsDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configured ? configured : path.join(homedir, ".claude");
  return path.join(path.resolve(homedir, configDir.normalize("NFC")), "skills");
}

/**
 * Codex reads personal skills from `$HOME/.agents/skills` AND `$CODEX_HOME/skills`.
 * `$HOME/.agents/skills` is the one root it reads whatever CODEX_HOME is set to,
 * so that is the one libi writes (measured against codex-cli 0.153.4).
 */
function codexUserSkillsDir(_env: NodeJS.ProcessEnv, homedir: string): string {
  return path.join(homedir, ".agents", "skills");
}

export const AGENT_SKILL_TARGETS: readonly AgentSkillTarget[] = [
  {
    agentId: "claude-code",
    name: "Claude Code",
    projectDialect: ".claude/skills",
    userSkillsDir: claudeUserSkillsDir,
    userSkillsDisplay: "~/.claude/skills",
  },
  {
    agentId: "codex",
    name: "Codex",
    projectDialect: ".agents/skills",
    userSkillsDir: codexUserSkillsDir,
    userSkillsDisplay: "~/.agents/skills",
  },
];

export function skillTargetFor(agentId: SetupAgentId): AgentSkillTarget {
  const target = AGENT_SKILL_TARGETS.find((t) => t.agentId === agentId);
  if (!target) throw new Error(`no skill target for agent ${JSON.stringify(agentId)}`);
  return target;
}

/** The resolved user-level dir as copy shows it: `~` for the home prefix, the full path otherwise. */
export function displayUserSkillsDir(target: AgentSkillTarget, env: NodeJS.ProcessEnv, homedir: string): string {
  return displayHomePath(target.userSkillsDir(env, homedir), homedir);
}

/** An absolute path as copy shows it: `~` for the home prefix, the full path otherwise. */
export function displayHomePath(abs: string, homedir: string): string {
  const home = path.resolve(homedir);
  if (abs === home) return "~";
  return abs.startsWith(home + path.sep) ? "~" + abs.slice(home.length).split(path.sep).join("/") : abs;
}
