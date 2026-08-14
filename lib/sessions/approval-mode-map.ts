import type { ApprovalMode } from "@/lib/approval/mode";

/**
 * Per-agent approval-mode vocabulary.
 *
 * Different ACP adapters advertise DIFFERENT mode-id vocabularies:
 *   - claude-agent-acp: `default | acceptEdits | bypassPermissions`
 *   - codex-acp:        `read-only | auto | full-access`
 *
 * The old single hardcoded `toAcpMode()` returned Claude's `bypassPermissions`
 * for both agents. Pushed to codex, that id isn't advertised → ACP
 * `RequestError: Invalid params (-32602)` `approval.mode.set_failed`. This map
 * kills that bug by mapping each libi `ApprovalMode` to the id the SPECIFIC
 * agent actually advertises.
 *
 * NB codex `ask` → `"auto"` (NOT `"read-only"`): the agent MUST be able to
 * write per-overlay code files even when libi is in ask/approval mode. The
 * libi-side policy still enforces per-tool approval prompts — this only tells
 * the agent process which ACP mode to run in.
 */
const AGENT_MODE_MAP: Record<string, Record<ApprovalMode, string>> = {
  "claude-code": {
    ask: "default",
    auto: "bypassPermissions",
    "auto-with-generations": "bypassPermissions",
  },
  codex: {
    ask: "auto",
    auto: "full-access",
    "auto-with-generations": "full-access",
  },
};

/**
 * Resolve the ACP mode id to push to `agentId` for the given libi
 * `ApprovalMode`, gated on the agent's advertised `availableModes`.
 *
 * Returns the mapped id ONLY when it is present in `availableModes`. Returns
 * `null` (→ caller skips the push + warns `approval.mode.unsupported_by_agent`)
 * when:
 *   - the agent is unmapped (unknown vocabulary), OR
 *   - `availableModes` is undefined/unknown (never push an unverified id blind —
 *     that blind push to codex is exactly the -32602 bug), OR
 *   - the mapped id is not in `availableModes`.
 *
 * By construction this NEVER returns `"bypassPermissions"` for `agentId`
 * `"codex"` — codex's map has no such value.
 */
export function acpModeFor(
  agentId: string,
  mode: ApprovalMode,
  availableModes: { id: string }[] | undefined,
): string | null {
  const agentMap = AGENT_MODE_MAP[agentId];
  if (!agentMap) return null;

  const target = agentMap[mode];
  if (!target) return null;

  if (!availableModes) return null;
  if (!availableModes.some((m) => m.id === target)) return null;

  return target;
}
