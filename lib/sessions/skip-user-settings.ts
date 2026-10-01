/**
 * Whether an in-app Claude session leaves out the host's USER setting source
 * (`~/.claude/*` and the user-scope MCP servers in `~/.claude.json`): the
 * skill-eval harness sets both flags, so its verdicts don't depend on whose
 * machine ran them (`lib/sessions/session-meta.ts`). Both are required, so a
 * stray env var never changes a real user's session.
 *
 * Everything that reasons about what that session loads — the session's own
 * `settingSources`, provider detection (`lib/providers/detect.ts`), the
 * test-mode fakes' aliases (`lib/mcp-config.ts`) — asks this, so they can't
 * disagree about the user scope.
 */
export function skipsUserSettings(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.LIBI_TEST_MODE === "1" && env.LIBI_AGENT_SKIP_USER_SETTINGS === "1";
}
