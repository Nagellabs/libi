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
  // core creation (UI-initiated; agent-driven creation is covered by tool_used)
  "piece_created",
  "export_started",
  "export_completed",
  "agent_message_sent",
  // asset / feature usage (UI-initiated; not covered by the tool_used wrap)
  "file_uploaded",
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
