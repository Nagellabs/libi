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
  // Setting up an agent (Task 14) — the funnel between "the app is open" and
  // "a message got sent". Every step below fires on a REAL success path,
  // never on a click alone, or the funnel looks healthy while people are
  // stuck. Most carry no params (there's nothing bounded to say beyond
  // "this step was reached"); the ones that do are documented per event.
  //
  // The persona question actually painted on screen — not merely "the
  // onboarding-state fetch resolved". Guarded to fire once per appearance
  // (a ref, not a render count), so React re-rendering the modal while it's
  // still up never double-counts it.
  "persona_prompt_shown",
  // The connect-an-agent takeover replaced the editor (`rightRegionMode`
  // flipped to "onboarding" in app/(app)/editor/page.tsx). Same
  // once-per-appearance guard as `persona_prompt_shown`.
  "agent_connect_shown",
  // The install/sign-in action was started — emitted from the ONE place all
  // three surfaces run it through, `useAgentSetupCardState().onAction`, so
  // the sidebar's own `InstallChip` (which renders differently and never used
  // the shared card) reports its installs too. `agent` is the two-entry
  // registry id (`claude-code` | `codex`); `action` is `install` | `sign_in`;
  // `surface` is `onboarding` | `chat` | `sidebar` — the three surfaces that
  // can actually emit this. (`AnalyticsSurface` also carries `settings`,
  // which only `agent_sign_in_opened` reaches.) All closed, construction-time
  // enums, never free text.
  "agent_setup_started",
  // The manual "Or do it yourself" Copy button, in `ManualInstructionsBlock`.
  // Same bounded `agent`/`action` pair as `agent_setup_started` — this is
  // the do-it-yourself fork of that step, not a separate funnel branch.
  "agent_setup_command_copied",
  // `lib/jobs/runners/agent-install.ts` reached its VERIFY step and the
  // adapter is actually usable — not merely "npm exited 0" (see the
  // partial-install trap documented in lib/agents/claude-native-binary.ts).
  // `agent` is the bounded registry id; fires for the already-installed fast
  // path too, since that path re-verifies the same two primitives.
  "agent_install_completed",
  // The same runner's failure path. `reason` is mapped through
  // `installFailureReason` (lib/agents/runtime-install.ts) — the raw
  // npm/verification diagnostic routinely contains an absolute filesystem
  // path (see `claudeNativeBinaryMissingError`) and must never reach an
  // event param; only the bounded verdict does.
  "agent_install_failed",
  // libi handed a sign-in command to its OWN terminal
  // (`useRunRemedyInTerminal`), fired only once the terminal has actually
  // spawned — never on the button click, which can still fail to open one.
  // `agent`/`surface` are the same bounded pair the setup-card events use.
  "agent_sign_in_opened",
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
  "terminal_session_started",
  "mcp_server_added",
  "codex_connect_toggled",
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
  // privacy
  "analytics_opt_out",
  "analytics_opt_in",
] as const;

export type AnalyticsEventName = (typeof EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(EVENT_NAMES);
export function isEventName(name: string): name is AnalyticsEventName {
  return EVENT_NAME_SET.has(name);
}

/** Where a setup action (an install, a sign-in, a copy) was initiated from —
 *  a closed, bounded set of UI surfaces. Shared by `AgentSetupCard`'s own
 *  `surface` prop (`"onboarding"` | `"chat"`, the only two places that card
 *  renders), by `useAgentSetupCardState` (those two plus `"sidebar"`, whose
 *  install chip is its own rendering of the same state), and by
 *  `useRunRemedyInTerminal`'s callers (`"sidebar"` from
 *  `app-sidebar.tsx`/`sidebar-session-list.tsx`, `"settings"` from the MCPs &
 *  Skills page's `connect-tools-section.tsx`) — every emit site draws from
 *  the same set instead of each call site inventing its own string. Not every
 *  event can produce every member; each event's own comment says which. */
export type AnalyticsSurface = "onboarding" | "sidebar" | "chat" | "settings";

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
