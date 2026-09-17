/**
 * Environment variables a running Claude Code session sets for ITS children.
 * When libi itself was started from inside such a session (`npm run dev` in a
 * Claude Code terminal), they reach every process libi spawns — the setup
 * terminals, the regular terminal, the agent adapters — and a `claude` started
 * there believes it is a child session ("Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker"). These are session plumbing, not user
 * configuration: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_*`
 * and everything else pass through untouched.
 */
export const HOST_SESSION_ENV_MARKERS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
];

/** A copy of `env` without the host session markers. */
export function stripHostSessionEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of HOST_SESSION_ENV_MARKERS) delete out[name];
  return out as T;
}
