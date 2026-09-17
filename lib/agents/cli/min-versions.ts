import type { SetupAgentId } from "@/lib/agents/setup/commands";

/**
 * The lowest version of each CLI verified against the pinned adapters in
 * `lib/agents/runtime-packages.ts`: a session opens, a prompt completes, a
 * `libi.*` tool with progress succeeds, a permission round-trips, cancel works,
 * and an unauthenticated CLI yields the ACP auth-required shape. Raise a value
 * only after re-running that whole check against the new version.
 */
export const AGENT_CLI_MIN_VERSION: Record<SetupAgentId, string> = {
  "claude-code": "2.1.245",
  codex: "0.153.4",
};

/** Whether `claude update` is a real subcommand (verified against claude 2.1.245: `claude update --help` exits 0). */
export const CLAUDE_UPDATE_SUBCOMMAND_EXISTS = true;
