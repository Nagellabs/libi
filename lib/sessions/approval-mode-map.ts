import type { ApprovalMode } from "@/lib/approval/mode";

/**
 * Per-agent approval-mode vocabulary.
 *
 * Different ACP adapters advertise DIFFERENT mode-id vocabularies:
 *   - claude-agent-acp 0.75.1: `default | acceptEdits | plan | auto`, plus
 *     `bypassPermissions` only when `ALLOW_BYPASS` (dist/session-mode.js
 *     `buildAvailableModes`, :189-224; dist/permissions/modes.js:1-3 — false
 *     for a root process without `IS_SANDBOX`).
 *   - codex-acp 1.10.0:        `read-only | agent | agent-full-access`
 *     (`AgentMode.all()` in its dist/index.js; ≤ 1.6.x advertised
 *     `read-only | auto | full-access`, kept as fallbacks below for a runtime
 *     installed by an older libi).
 *
 * The old single hardcoded `toAcpMode()` returned Claude's `bypassPermissions`
 * for both agents. Pushed to codex, that id isn't advertised → ACP
 * `RequestError: Invalid params (-32602)` `approval.mode.set_failed`. This map
 * kills that bug by mapping each libi `ApprovalMode` to the id the SPECIFIC
 * agent actually advertises. Each entry is an ordered candidate list; the
 * first id the agent advertises wins.
 *
 * Which agent mode each libi mode maps to is decided by ONE question: does the
 * agent still route tool permission requests to libi in that mode? libi's own
 * `decidePermissionAction` (session-event-handler.ts) is where the approval
 * policy lives — it auto-allows everything under `auto` except a libi
 * extension marked "requires approval", and prompts for everything under
 * `ask`. That handler can only fire when the agent asks.
 *
 *   - claude-code `ask` and `auto` → `default`. claude-agent-acp hands the
 *     ACP mode straight to the SDK as `permissionMode`, and "Claude Code
 *     applies bypassPermissions before invoking canUseTool" (its
 *     dist/acp-agent.js, canUseTool; dist/file-change-audit.js says the same),
 *     so under `bypassPermissions` libi's handler never runs and the
 *     extension gate is unreachable. In `default` the SDK auto-allows its
 *     read-only built-ins itself and routes every other tool call (Bash,
 *     Edit, every MCP tool) through canUseTool → libi, which auto-allows on
 *     the spot. Only `auto-with-generations` — the never-prompt mode — pushes
 *     `bypassPermissions`. Under root that id is not advertised, so the push
 *     is skipped (null → `approval.mode.unsupported_by_agent`) and the
 *     session stays in the adapter's own default, `default`: the never-prompt
 *     mode degrades to "auto", and gated extensions still prompt.
 *
 *   - codex: libi's extension gate is NOT IMPLEMENTED for codex. This block
 *     used to say it CANNOT be, and that was wrong — corrected 2026-09-09
 *     from live observation on codex CLI 0.153.4 / codex-acp 1.10.0.
 *
 *     What is still true: the codex-acp mode push only sets `approvalPolicy` /
 *     `approvalsReviewer` / sandbox (`AgentMode`, dist/index.js ~27217-27260),
 *     the adapter bridges three approval kinds to ACP
 *     `session/request_permission` — `item/commandExecution/requestApproval`,
 *     `item/fileChange/requestApproval`, `item/permissions/requestApproval`
 *     (~29133-29135, handlers ~25640-25698), none of them an MCP tool call —
 *     and the MCP-shaped route, Codex core's own
 *     `mcpServer/elicitation/request` with
 *     `codex_approval_kind: "mcp_tool_call"` (`handleElicitation`
 *     ~26126-26160, `buildMcpPermissionRequest` ~25930-25965), builds a
 *     request carrying NO tool name. `extractToolMeta` on that request alone
 *     does yield `toolId: null`.
 *
 *     What was wrong: that route is not hypothetical (a `libi.list_pieces`
 *     call in `read-only` produced one, `_meta.is_mcp_tool_approval: true`),
 *     and the missing name is RECOVERABLE. The `session/update` `tool_call`
 *     delivered immediately before it on the same session carries the same
 *     `toolCallId` plus `rawInput: { server, tool }` and
 *     `_meta.is_mcp_tool_call: true`. This comment already mentioned the
 *     correlated `toolCallId` and treated it as a dead end; it is the key.
 *
 *     Two things bound what a codex gate could promise. It can only ever FIRE
 *     in `ask` — in `agent` / `agent-full-access` codex's own Guardian
 *     approves MCP calls (`decisionSource: "agent"`) and libi is never asked.
 *     And `Guardian Review`'s update does name the tool
 *     (`action: { type: "mcpToolCall", server, toolName }`) but is a report of
 *     a decision already made, not a request.
 *
 *     Until it is built, an extension's `requireApproval` is advisory for
 *     Codex (see LIMITATIONS in lib/approval/extensions.ts).
 *
 *     What the mapping CAN honour is the mode's promise about codex's own
 *     approvals. The old comment claimed `read-only` had to be avoided so the
 *     agent could write overlay-code files; that is false — `AgentMode.ReadOnly`
 *     (~27217-27231) has `sandboxPolicy: { type: "workspaceWrite" }` and
 *     `sandboxMode: "workspace-write"`, identical to `Agent` (~27232-27247).
 *     The real difference is `approvalsReviewer`: `"user"` in `read-only`,
 *     `"auto_review"` in `agent`. So:
 *       - `ask` → `read-only`: codex asks the USER for commands and file
 *         changes, which is what "Ask each time" promises, and still writes
 *         the workspace.
 *       - `auto` → `agent` (legacy `auto`): `approvalPolicy: "on-request"`
 *         with codex reviewing, so only what its reviewer flags reaches libi.
 *       - `auto-with-generations` → `agent-full-access` (legacy
 *         `full-access`): `approvalPolicy: "never"` — codex asks nothing.
 */
const AGENT_MODE_MAP: Record<string, Record<ApprovalMode, readonly string[]>> =
  {
    "claude-code": {
      ask: ["default"],
      auto: ["default"],
      "auto-with-generations": ["bypassPermissions"],
    },
    codex: {
      // `read-only` exists in both the 1.10.0 and the ≤ 1.6.x vocabularies.
      ask: ["read-only"],
      auto: ["agent", "auto"],
      "auto-with-generations": ["agent-full-access", "full-access"],
    },
  };

/**
 * Resolve the ACP mode id to push to `agentId` for the given libi
 * `ApprovalMode`, gated on the agent's advertised `availableModes`.
 *
 * Returns the first mapped candidate present in `availableModes`. Returns
 * `null` (→ caller skips the push + warns `approval.mode.unsupported_by_agent`)
 * when:
 *   - the agent is unmapped (unknown vocabulary), OR
 *   - `availableModes` is undefined/unknown (never push an unverified id blind —
 *     that blind push to codex is exactly the -32602 bug), OR
 *   - none of the mapped ids is in `availableModes`.
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

  const candidates = agentMap[mode];
  if (!candidates) return null;

  if (!availableModes) return null;
  const advertised = new Set(availableModes.map((m) => m.id));
  return candidates.find((id) => advertised.has(id)) ?? null;
}
