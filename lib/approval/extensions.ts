/**
 * The extension approval gate: does this tool belong to a libi extension the
 * user marked "requires approval" in Settings?
 *
 * LIMITATIONS
 * - The gate applies to Claude in-app sessions. claude-agent-acp routes every
 *   non-read-only tool call (including every MCP tool) through libi's
 *   `canUseTool` handler in `default` mode, with the tool's `mcp__server__tool`
 *   name as the request title — that is what `decidePermissionAction` keys on.
 * - For Codex the gate is NOT IMPLEMENTED. It is not impossible — that was
 *   this note's claim until a live spike disproved it on codex CLI 0.153.4 /
 *   codex-acp 1.10.0 (2026-09-09). Codex core DOES emit the MCP-tool-call
 *   approval (`_meta.is_mcp_tool_approval: true`), and while the request
 *   itself carries no name, the `session/update` `tool_call` delivered
 *   immediately before it on the same session carries the SAME `toolCallId`
 *   plus `rawInput: { server, tool }`. Correlating the two names the tool.
 *   Building it needs a `toolCallId → McpToolId` map in
 *   `SessionEventHandler`, read by `decidePermissionAction` when
 *   `extractToolMeta` yields null.
 *
 *   Note the narrower promise it could keep: the approval only ever FIRES in
 *   libi's `ask` mode. In `auto` / `auto-with-generations` codex's own
 *   Guardian approves MCP calls and libi is never asked.
 *
 *   Until that lands, `requireApproval` on an extension is ADVISORY for Codex
 *   — the manual's REQUIRES APPROVAL prose is what asks the agent to confirm;
 *   nothing in-app enforces it.
 * - Loopback: the agent's shell can reach the studio's routes and the MCP
 *   endpoint directly, past `canUseTool`. A card answer from a header-less
 *   loopback client is refused — the permission route takes the browser-only
 *   checks below — so an agent's own shell can't approve its own card without
 *   deliberately forging a browser request (limit 1 below). An extension's
 *   card is still a prompt, not a lock: that forgery is one curl flag away.
 *   Switching cards OFF instead of answering one is closed the same way: the
 *   approval mode (`PATCH /api/sessions/permission-modes`) and an extension's
 *   `requireApproval` (`PATCH /api/settings/mcp-servers/:id`) take the same
 *   checks, the general `PATCH /api/settings` ignores `agentApprovalModes`
 *   rather than being a second, unguarded way in, and the agent's own tool for the flag, `libi.update_mcp_server`,
 *   may only turn it ON — `requireApproval: false` is refused, because that
 *   core tool raises no card of its own in `auto` mode and would otherwise
 *   switch off the very prompt meant to stop it. Lowering a gate is the
 *   user's. What remains is limit 1 (forged headers); the approval MODE
 *   itself — under `auto-with-generations`, or a Claude settings allow-rule,
 *   no card appears at all, by the user's choice; and an agent that uses its
 *   own file tools to write that allow-rule into the user's Claude settings
 *   or to edit `<LIBI_HOME>/libi.db` directly — a same-user write libi cannot
 *   refuse (limit 2's class).
 *
 * PUBLISHING IS NOT AN APPROVAL-CARD MATTER ANY MORE (2026-09-24). A card is
 * structurally the wrong guard for a public action: it never appears under
 * `auto-with-generations` (bypassPermissions), nor when the user's Claude
 * settings already allow the tool, nor for Codex in-app sessions (above), nor
 * for the user's own Claude Code / Codex over `libi connect` — and the agent's
 * own shell can answer its card by forging the page's headers to the
 * permission route (limit 1 below). So the rule is
 * now structural and identical everywhere: an agent can PREPARE a publish,
 * only the user can publish.
 *   - `libi.publish_template` runs the local preflight, then its
 *     `template_publish_prepare` job makes the request's OWN example video and
 *     poster (exported / transcoded now, into
 *     `<LIBI_HOME>/template-publish-requests/<id>/`) and records a publish
 *     request (lib/templates/cloud/publish-requests.ts). Nothing leaves the
 *     machine, no publish starts, and its old `confirm: true` is ignored.
 *   - The user publishes from the Templates page's review panel, which plays
 *     exactly that example and shows that poster. Its confirm route
 *     (`POST /api/templates/cloud/publish-requests/:id/confirm`) is the only
 *     thing that starts a `template_publish` job — in-process, through the
 *     JobManager. `POST /api/jobs` refuses that kind from EVERY caller and
 *     `/api/jobs/:id/retry` never re-runs it (lib/jobs/user-started-kinds.ts).
 *   - The confirm is bound to what the review showed: a fingerprint of the
 *     template's text, settings and files plus the sha256 of the request's
 *     example and poster. The review, the confirm and the job each recompute
 *     it, and the job uploads the very buffers it hashed — nothing is
 *     re-exported or re-derived, so a source edited after the review changes
 *     nothing, and a request file swapped after it is refused. Single-use: the
 *     `confirmCode` rotates when claimed.
 *   - Cheap browser-only checks (lib/security/request-guard.ts#browserOnlyRefusal:
 *     `Sec-Fetch-Site: same-origin` and an `Origin` equal to the studio's own)
 *     guard every route that changes what the public catalog shows or who it
 *     is published as: the confirm, a template's visibility (both directions),
 *     the nickname, the creator-key import and its reveal. They also guard the
 *     other actions only the user takes: the approval card's answer
 *     (`POST /api/sessions/:id/permission`) and the two settings that decide
 *     whether a card appears (the approval mode, an extension's
 *     `requireApproval` — above), social publish / schedule / edit /
 *     delete / retry (`POST /api/social/posts` when `createdBy` is `"ui"`,
 *     `PATCH` / `DELETE /api/social/posts/:id`, `POST …/:id/retry`) and account
 *     connect / disconnect (`POST /api/social/oauth/start|disconnect`), the
 *     social settings (`PUT /api/social/settings`: the provider, and the
 *     defaults the composer seeds every new post from, `aiLabel` among them),
 *     the catalog report (`POST /api/templates/cloud/report`), and a chat's
 *     Restart session (`POST /api/sessions/:id/restart`, which can replace the
 *     agent's process). An agent's social
 *     DRAFT (`createdBy: "agent"`, from `libi.post_piece`) is not one of them;
 *     the route's own draft-only rule covers it. Each refusal answers
 *     `403 { code: "browser_only" }` and logs an `…_refused` op. The confirm also
 *     needs the request's `confirmCode`, which only the page's review read
 *     hands to a same-origin browser fetch — never an MCP tool, a tool result
 *     or a log line.
 *   - Agent-written code never runs in the studio origin in any shipped mode,
 *     where it would pass those checks for real: code, three and tracked-code
 *     overlay bodies run in the overlay sandbox, and custom effect bodies
 *     (`animate.js`) in the effect sampler — an opaque origin with
 *     `connect-src 'none'` — which hands the page numbers, never code
 *     (lib/sandbox/effect-sampler.ts). The one exception is the dev-only
 *     `LIBI_OVERLAY_SANDBOX=0` in-origin transport, for both overlay bodies and
 *     the effect sampler: it runs the same worker as a same-origin blob worker
 *     to tell a broken runtime from a blocking boundary, and it is refused when
 *     packaged or under `NODE_ENV=production` (lib/sandbox/mode.ts) — so
 *     neither `npx @nagellabs/libi` nor the desktop app can enter it. Storyboard
 *     sketch bodies run server-side in a Node child that could otherwise speak
 *     HTTP to loopback, so that worker locks itself before a body runs: no
 *     module loading and a data-only `process`
 *     (lib/storyboard/render/lock-runtime.ts). Any new path that runs
 *     agent-written code in the page, or in a Node process that can reach the
 *     network, reopens this; keep it sandboxed or locked.
 *
 * WHAT THAT DOES NOT CLOSE, stated plainly. Three ways remain:
 *   1. A program running as the user that DELIBERATELY forges a browser
 *      request. Every studio route is on loopback and every header the checks
 *      read can be forged by a local process: read the review route with a
 *      forged `Sec-Fetch-Site` (which yields the confirmCode), then POST the
 *      confirm with forged `Origin` / `Sec-Fetch-Site` — and likewise for the
 *      visibility, nickname and key routes, the approval card and its two
 *      settings, the social writes and settings, and the catalog report. The
 *      skill-eval harness (answering a card, choosing the social provider)
 *      and scripts/qa-social.js do exactly this on purpose, as stand-ins for
 *      the user against a hermetic studio (`pageHeaders` in the harness).
 *   2. A program that reads the creator key straight out of
 *      `<LIBI_HOME>/libi.db` and speaks the catalog's publish protocol itself.
 *   3. An agent that drives a REAL browser or the desktop — claude-in-chrome,
 *      a Playwright MCP, computer-use — to open `/templates?review=<id>` and
 *      click "Publish publicly". That is a genuine click, indistinguishable to
 *      the studio from the user's own; it happens visibly on the user's screen.
 * 1 and 2 are the same-user-process boundary every desktop app has, and there
 * is no UI authentication behind it. None of the three is a libi tool call,
 * and none happens in a normal configuration by accident: a confused or
 * prompt-injected agent calling libi's tools, or libi's MCP endpoint,
 * prepares a request and stops there.
 *   Follow-up, not built: in the packaged app, ask Electron main for a native
 *   confirmation (`dialog.showMessageBox`) before the confirm POST. Renderer
 *   script, and a browser-automation tool driving the page, cannot answer a
 *   main-process dialog (computer-use still can: it clicks the screen). It
 *   needs a change under electron/ — a new IPC handler and preload method; no
 *   existing shell or preload API shows a confirmation.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { extensionForToolName } from "@/mcp/registry/bundled";
import { parseMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";

/** Server ids that carry libi's own tools. Only these can own an extension
 *  tool; a provider MCP's tool never reaches the DB read. */
const LIBI_SERVER_IDS: ReadonlySet<string> = new Set(["libi", "libi-tracking"]);

/**
 * Each extension's install-path tools. They resolve to the extension via its
 * `toolPrefixes` like any other tool, but they are the way the user gets past
 * "not installed" — holding them behind the extension's own approval flag
 * would leave a `needs_install` result with no unprompted way out.
 * `libi.verify_install` is the read-only "is the tracking engine installed?"
 * check on that same path: gating it would gate the question, not the
 * install. Registered names, verbatim (`mcp/server.ts`, `mcp/tracking-mcp/`).
 */
const EXTENSION_INSTALL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "libi.install_tracking_engine",
  "libi.verify_install",
  "libi.whisper_download_model",
  "libi.tts_download_model",
  "libi.music_download_model",
  "libi.music_install_analysis_deps",
]);

/** True when `toolName` (the registered name, e.g. `libi.music_download_model`)
 *  is one of the extension install-path tools exempt from the gate. */
export function isExtensionInstallTool(toolName: string): boolean {
  return EXTENSION_INSTALL_TOOL_NAMES.has(toolName);
}

/**
 * True when `toolId` belongs to a libi extension whose row has
 * `requireApproval = true`.
 *
 * This replaces the deleted `generation: true` gate. The difference is what it
 * gates: `generation` gated a THIRD-PARTY MCP that spends the user's money;
 * this gates a LIBI extension that spends the user's disk, GPU or minutes.
 * A provider MCP's own approval behaviour is the agent's business, not libi's
 * — libi does not manage those servers.
 *
 * Only libi's own tool ids can match, so a provider tool never reaches the DB
 * read. Built-in tools (toolId === null) and the extensions' own install
 * tools (`isExtensionInstallTool`) are never gated.
 */
export function isApprovalRequiredExtensionTool(toolId: McpToolId | null): boolean {
  if (!toolId) return false;
  const parsed = parseMcpToolId(toolId);
  if (!parsed) return false;
  if (!LIBI_SERVER_IDS.has(parsed.serverId)) return false;
  if (isExtensionInstallTool(parsed.toolName)) return false;
  const def = extensionForToolName(parsed.toolName);
  if (!def) return false;
  try {
    const row = getDb()
      .select({ requireApproval: mcpServers.requireApproval })
      .from(mcpServers)
      .where(eq(mcpServers.id, def.id))
      .get();
    // No row (a DB that predates the def) means the def's own default applies.
    return row ? row.requireApproval : def.requireApproval;
  } catch {
    // DB unavailable — fall back to the def, never to "no approval needed".
    return def.requireApproval;
  }
}
