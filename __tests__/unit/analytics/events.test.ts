import { describe, expect, it } from "vitest";
import { EVENT_NAMES, isEventName, sanitizeParams, type AnalyticsSurface } from "@/lib/analytics/events";

describe("event taxonomy", () => {
  it("includes core events", () => {
    expect(EVENT_NAMES).toContain("tool_used");
    expect(EVENT_NAMES).toContain("page_view");
    expect(EVENT_NAMES).toContain("analytics_opt_out");
  });
  it("includes the onboarding milestones", () => {
    expect(EVENT_NAMES).toContain("persona_selected");
    expect(EVENT_NAMES).toContain("agent_connected");
  });
  it("includes the Providers tab and provider-suggestion events", () => {
    expect(EVENT_NAMES).toContain("provider_command_opened");
    expect(EVENT_NAMES).toContain("provider_suggested");
  });
  it("no longer carries the retired setup-card, sign-in, Codex-connect and connect-panel events", () => {
    // `provider_connected` is NOT in this list: the name came back with the
    // Providers tab's observed-detection semantics (see events.ts).
    for (const retired of [
      "extension_install_started",
      "agent_setup_started",
      "agent_setup_command_copied",
      "agent_sign_in_opened",
      "codex_connect_toggled",
    ]) {
      expect(EVENT_NAMES).not.toContain(retired);
      expect(isEventName(retired)).toBe(false);
    }
  });
  it("keeps the agent install funnel's completion events", () => {
    expect(EVENT_NAMES).toContain("agent_install_completed");
    expect(EVENT_NAMES).toContain("agent_install_failed");
  });
  it("surfaces are the three setup-terminal tabs of the Agents page plus the suggestion-narrowed Providers tab", () => {
    const surfaces: AnalyticsSurface[] = ["agents", "global-setup", "providers", "suggestion"];
    expect(new Set(surfaces).size).toBe(4);
    // @ts-expect-error — the onboarding takeover is gone
    const onboarding: AnalyticsSurface = "onboarding";
    // @ts-expect-error — the right-region connect panel is gone
    const panel: AnalyticsSurface = "provider-panel";
    // @ts-expect-error — the Libi MCP tab owns no setup terminal (SetupSurface), so nothing ever reported it
    const libiMcp: AnalyticsSurface = "libi-mcp";
    // @ts-expect-error — the in-chat card only links to the Providers tab; the tab reports `suggestion`
    const chatCard: AnalyticsSurface = "chat-card";
    // @ts-expect-error — the editor's sidebar no longer initiates setup actions
    const sidebar: AnalyticsSurface = "sidebar";
    // @ts-expect-error — nor does the chat panel
    const chat: AnalyticsSurface = "chat";
    // @ts-expect-error — nor does the Settings page
    const settings: AnalyticsSurface = "settings";
    expect([onboarding, panel, libiMcp, chatCard, sidebar, chat, settings]).toHaveLength(7);
  });
  it("includes the 2026-09-18 audit's funnel additions", () => {
    for (const n of [
      "agent_auth_rejected",
      "first_piece_created",
      "agents_tab_viewed",
      "libi_mcp_connected",
      "mcp_cli_session_opened",
      "dependency_installed",
      "provider_connected",
    ]) {
      expect(EVENT_NAMES).toContain(n);
      expect(isEventName(n)).toBe(true);
    }
  });
  it("includes the Agents page setup wizard's step event", () => {
    expect(EVENT_NAMES).toContain("agent_wizard_step_completed");
  });
  it("includes the skills-install event", () => {
    expect(EVENT_NAMES).toContain("skills_install_added");
    expect(isEventName("skills_install_added")).toBe(true);
  });
  it("isEventName guards unknown names", () => {
    expect(isEventName("tool_used")).toBe(true);
    expect(isEventName("definitely_not_real")).toBe(false);
  });
});

describe("sanitizeParams", () => {
  it("drops undefined and truncates long strings to 100 chars", () => {
    const out = sanitizeParams({ a: undefined, b: "x".repeat(150), c: 3 });
    expect(out).not.toHaveProperty("a");
    expect((out.b as string).length).toBe(100);
    expect(out.c).toBe(3);
  });
  it("returns empty object for undefined input", () => {
    expect(sanitizeParams(undefined)).toEqual({});
  });
});
