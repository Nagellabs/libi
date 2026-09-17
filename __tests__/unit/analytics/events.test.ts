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
    for (const retired of [
      "provider_connected",
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
  it("surfaces are the Agents page tabs, the chat card, and the editor's sidebar/chat/settings", () => {
    const surfaces: AnalyticsSurface[] = ["sidebar", "chat", "settings", "agents", "global-setup", "libi-mcp", "providers", "chat-card"];
    expect(new Set(surfaces).size).toBe(8);
    // @ts-expect-error — the onboarding takeover is gone
    const onboarding: AnalyticsSurface = "onboarding";
    // @ts-expect-error — the right-region connect panel is gone
    const panel: AnalyticsSurface = "provider-panel";
    expect([onboarding, panel]).toHaveLength(2);
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
