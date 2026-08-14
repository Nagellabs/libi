/**
 * Shared types for the install-from-URL backend (Plan B, Task B3.2).
 *
 * The agent + UI flow:
 *   1. User pastes a GitHub URL.
 *   2. Server downloads the repo tarball, scans it.
 *   3. Returns one of four candidate kinds:
 *      - `claude-plugin`  → install via `installClaudePlugin`
 *      - `single-skill`   → install via `installSingleSkill`
 *      - `multi-skill`    → return the picker, then a second call with selectedPaths
 *      - `unknown`        → hand off to the agent in a new chat session
 */

export type GithubRepoRef = {
  owner: string;
  repo: string;
  /** Branch, tag, or commit SHA. Default `main` (or `master` as a fallback). */
  ref?: string;
  /** Optional subdirectory within the repo. */
  subPath?: string;
};

export type McpServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/**
 * Minimal subset of fields we read from a `.claude-plugin/plugin.json`
 * manifest. The full Claude-plugin spec contains more fields; we only
 * care about the ones we act on.
 */
export type ClaudePluginManifest = {
  name: string;
  version?: string;
  description?: string;
  /** Each entry is a relative path to a skill directory (containing SKILL.md). */
  skills?: string[];
  /** Map of server name → MCP config. Matches Claude Code's settings.json shape. */
  mcpServers?: Record<string, McpServerEntry>;
};

export type InstallCandidate =
  | { kind: "claude-plugin"; basePath: string; manifest: ClaudePluginManifest }
  | { kind: "single-skill"; basePath: string; skillPath: string; name: string }
  | { kind: "multi-skill"; basePath: string; skills: Array<{ name: string; relPath: string }> }
  | { kind: "unknown"; basePath: string; reason: string };

export type InstallResult = {
  installed: Array<{ kind: "skill" | "mcp"; name: string; note?: string }>;
  failed: Array<{ kind: "skill" | "mcp"; name: string; error: string }>;
};

/** Thrown by `installSingleSkill` when a user skill with the same name already exists. */
export class SkillCollisionError extends Error {
  constructor(public readonly name: string) {
    super(
      `skill ${name} already exists; rename it in the URL repo's frontmatter or in libi first`,
    );
    this.name = "SkillCollisionError";
  }
}

/** Re-exported from the neutral shared home so every caller throws the same
 *  error type. See `lib/agents/errors.ts`. */
export { NoAgentConfiguredError } from "@/lib/agents/errors";
