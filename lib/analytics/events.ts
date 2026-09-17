// lib/analytics/events.ts
// Single source of truth for analytics event names + param shapes. Imported by
// both the client (gtag) and server (Measurement Protocol) transports.
// Discipline: snake_case, <=40 chars, bounded-cardinality params (enums only —
// never raw user text, file names, prompts, or IDs).

export const EVENT_NAMES = [
  // activation / onboarding (fired once via mark-once milestones)
  "first_launch",
  "first_export",
  "persona_selected",
  "agent_connected",
  // activation / onboarding (per-occurrence — NOT mark-once)
  //
  // The first-run demo film was built end to end (download + verify + write).
  // Param is the definition version only — bounded by construction. This is
  // the adoption signal for onboarding actually completing, as distinct from
  // `persona_selected`, which fires before anything is built.
  //
  // Emitted by `lib/jobs/runners/onboarding-piece.ts` on every non-reused
  // build, so a `force` rebuild fires it again; a dedupe hit fires nothing.
  // That is why it sits below the mark-once group rather than in it.
  "onboarding_piece_built",
  // Setting up an agent — the funnel between "the app is open" and "a message
  // got sent". Every step below fires on a REAL success path, never on a click
  // alone, or the funnel looks healthy while people are stuck. Most carry no
  // params (there's nothing bounded to say beyond "this step was reached");
  // the ones that do are documented per event.
  //
  // The persona question actually painted on screen — not merely "the
  // onboarding-state fetch resolved". Guarded to fire once per appearance
  // (a ref, not a render count), so React re-rendering the modal while it's
  // still up never double-counts it.
  "persona_prompt_shown",
  // `lib/jobs/runners/agent-install.ts` reached its VERIFY step and the
  // adapter is actually usable — not merely "npm exited 0". `agent` is the
  // bounded registry id; fires for the already-installed fast path too, since
  // that path re-verifies the same primitives.
  "agent_install_completed",
  // The same runner's failure path. `reason` is mapped through
  // `installFailureReason` (lib/agents/runtime-install.ts) — the raw
  // npm/verification diagnostic routinely contains an absolute filesystem
  // path and must never reach an event param; only the bounded verdict does.
  "agent_install_failed",
  // First user-sent chat message this install — via the mark-once milestone
  // primitive (`markAnalyticsMilestoneOnce`, the same one `POST
  // /api/analytics/milestone` wraps for client callers), NOT fired per
  // message, or this would just be a message counter wearing a first_*
  // name. No params.
  "first_message_sent",
  // core creation (UI-initiated; agent-driven creation is covered by tool_used)
  "piece_created",
  "export_started",
  "export_completed",
  "agent_message_sent",
  // asset / feature usage (UI-initiated; not covered by the tool_used wrap)
  "file_uploaded",
  // Asset revealed in the OS file manager. Param `source` is
  // "context_menu" | "summary_tab" | "asset_grid" — bounded by construction,
  // one value per surface that offers the action. The path itself is NEVER
  // sent: it is unbounded and personal.
  "asset_revealed",
  // Piece aspect ratio changed from the Preview-row picker. Params:
  // `ratio` is a catalog id ("9:16" | "4:5" | "1:1" | "16:9" | "4:3" | "21:9")
  // and `mode` is "direct" (empty piece, written immediately) | "dispatched"
  // (piece had overlays, handed to the agent to reflow). Both are bounded by
  // construction. Dimensions are NOT sent — an agent can set any, so they are
  // unbounded.
  "aspect_ratio_changed",
  // A setup terminal was spawned from the Agents page with ONE command waiting
  // at its prompt (components/agents-page/setup-terminal-host.tsx). Fired only
  // once the terminal exists. `surface` is `agents | global-setup | providers`;
  // `action` is the fixed SetupAction enum (install, sign-in, connect-libi,
  // disconnect-libi, reconnect-libi, provider-add, provider-replace,
  // provider-remove, provider-sign-in). The command text is never sent.
  "setup_terminal_opened",
  // A wizard step on the Agents page reached its SUCCESS path (never a click
  // alone): `choose` (an agent picked), `install` (Next past step 2 with a
  // usable CLI), `sign-in` (confirmation stored), `connect` (libi tools
  // observed connected — Skip fires nothing), `open-chat` (a session created).
  // `agent` is `claude-code | codex`. Fixed enums, no free text.
  "agent_wizard_step_completed",
  "terminal_session_started",
  // A newer @nagellabs/libi runtime was fetched + laid down from Settings
  // (applies at next launch). Fired server-side at the install success path in
  // `lib/jobs/runners/runtime-update.ts`. The only param is
  // `previous_source: "bundled" | "user" | "dev"` — bounded by construction;
  // version strings are deliberately NOT sent (unbounded over the product's
  // life). This is the adoption signal for the npm-as-runtime model: how many
  // installs actually move off the snapshot their .app shipped with.
  "runtime_update_installed",
  "version_restore",
  "overlay_added",
  "overlay_edited",
  "preset_applied",
  "effect_applied",
  "effect_previewed",
  "text_3d_used",
  // "Make it 3D" toggled ON for any flat overlay kind (text/image/video/code).
  // Reports the kind so all flat kinds funnel through one bounded event.
  "overlay_3d_used",
  // chat command palette + context meter (UI-initiated; the resulting agent
  // turn is covered by agent_message_sent / tool_used)
  "chat_slash_command",
  "context_meter_opened",
  // surface / engagement
  "page_view",
  "page_engagement",
  // cross-cutting
  "tool_used",
  // membership interest — fired only after the server accepts the signup, so
  // this counts waitlist rows that exist and not form submissions that failed.
  // The only param is `plan`, bounded by the WaitlistCard's featureKey union;
  // the address itself is never sent here.
  "pro_waitlist_joined",
  // A site announcement banner was displayed (components/layout/
  // announcement-banner.tsx). The only param is `kind: "feature" | "issue"`
  // — bounded by construction; announcement ids and text are never sent.
  "announcement_shown",
  // A user submitted the feedback form in Settings → General
  // (components/settings/feedback-section.tsx), fired from the widget's
  // onSubmitSuccess so it counts messages Sentry accepted, not form opens.
  // Params are two booleans — `with_email` and `with_screenshot` — bounded by
  // construction. The message body and the email address are NEVER sent here;
  // they go to Sentry and nowhere else.
  "feedback_submitted",
  // `libi connect` completed (lib/cli/connect-command.ts) — the adoption
  // signal for using libi from the user's OWN Claude Code / Codex instead of
  // the in-app agent. Params are two construction-time enums:
  // `agent: "both" | "claude" | "codex" | "none"` (which registrations
  // actually succeeded — "none" means both steps only PRINTED a command) and
  // `scope: "folder" | "global"`. The directory itself is never sent.
  "cli_connected",
  // libi installed its skills for the user's OWN Claude Code / Codex
  // (mcp/skills/installs.ts, on the success path of a NEW recorded install —
  // re-adding an existing one fires nothing). Every param is a construction-
  // time enum: `agent: "claude" | "codex"`, `scope: "user" | "folder"`,
  // `source: "ui" | "cli"`. The folder itself is never sent.
  "skills_install_added",
  // An Add / Replace / Remove on the Providers tab on /agents
  // (components/agents-page/providers-tab/providers-tab.tsx) typed its command
  // into the tab's setup terminal (surface `providers`) — fired once that
  // terminal exists, never on a refused spawn. Every param is a
  // construction-time enum: `provider` is a catalog `ProviderId`, `agent` is
  // `"claude" | "codex"` (the catalog's command key, NOT the registry id),
  // `surface` is an `AnalyticsSurface`. The command text and any key are never
  // sent.
  "provider_command_opened",
  // The agent had no provider for a media kind and called
  // `libi.suggest_provider` (a card in the chat in-app, the commands as text
  // on a CLI). Fired from the MCP process on the tool's success path; the
  // `kind` param is the schema's enum (image | video | music | voice | sfx |
  // transcription). The agent's `reason` line is user-shaped and never sent.
  "provider_suggested",
  // privacy
  "analytics_opt_out",
  "analytics_opt_in",
] as const;

export type AnalyticsEventName = (typeof EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(EVENT_NAMES);
export function isEventName(name: string): name is AnalyticsEventName {
  return EVENT_NAME_SET.has(name);
}

/** Where a setup action was initiated from — a closed, bounded set of UI
 *  surfaces, so every emit site draws from the same set instead of inventing
 *  its own string. `agents`, `global-setup`, `libi-mcp` and `providers` are tabs of
 *  the `/agents` page (each owns a setup terminal; the Providers tab's
 *  `provider_command_opened` reports `providers`); `chat-card` is the in-chat
 *  provider suggestion card; `sidebar` and `chat` are the editor's sidebar and
 *  chat panel; `settings` is the Settings page. Not every event can produce
 *  every member; each event's own comment says which. */
export type AnalyticsSurface = "sidebar" | "chat" | "settings" | "agents" | "global-setup" | "libi-mcp" | "providers" | "chat-card";

/** The catalog's command key, as the Providers tab's events report it. This
 *  is the `commands.{claude,codex}` selector from `lib/providers/catalog.ts`,
 *  not the registry id `AnalyticsAgentId` carries — the two are kept apart
 *  on purpose so a reader of the analytics knows which one they are looking
 *  at. */
export type AnalyticsProviderAgent = "claude" | "codex";

/** The two agent ids the setup/funnel events report. Narrows an
 *  unconstrained id (an `AgentSetup.id`, a `SessionEntry.agentId`, an
 *  `AgentReadiness`'s `agentId`, etc. — all plain `string` in their own
 *  modules) down to the bounded param GA4 requires. Returns undefined for
 *  `"terminal"` or anything else so a caller can skip the event entirely
 *  rather than ever send an unbounded id as a param. */
export type AnalyticsAgentId = "claude-code" | "codex";
export function toAgentEventId(id: string | null | undefined): AnalyticsAgentId | undefined {
  return id === "claude-code" || id === "codex" ? id : undefined;
}

export type AnalyticsParams = Record<string, string | number | boolean>;

/** Drop undefined/null, coerce, truncate string values to GA4's 100-char limit. */
export function sanitizeParams(
  params: Record<string, unknown> | undefined,
): AnalyticsParams {
  if (!params) return {};
  const out: AnalyticsParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v.slice(0, 100);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = String(v).slice(0, 100);
  }
  return out;
}
