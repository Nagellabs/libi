/**
 * Per-agent session `_meta` for `newSession(...)`.
 *
 * claude-agent-acp reads a `claudeCode`-namespaced options bag; here we ensure
 * thinking content is streamed (`display: "summarized"`) rather than omitted,
 * which is the default on Opus 4.7+. Codex (and any non-claude agent) ignores
 * unknown `_meta` keys, so sending the claude-namespaced bag is a benign no-op —
 * but it's Claude-specific, so we send `{}` instead to keep the wire honest.
 *
 * NOTE: a codex reasoning-effort control is NOT yet plumbed here. Spike S3
 * (SP2 Task 4.4 / G2) was statically inconclusive — codex-acp is a launcher and
 * advertises no confirmed reasoning-effort config option — so that half is
 * deferred to Phase 5 live verification. This is not an oversight.
 */
export function sessionMetaFor(agentId: string): Record<string, unknown> {
  if (agentId === "claude-code") {
    return {
      claudeCode: {
        options: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    };
  }
  return {};
}
