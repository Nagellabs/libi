/**
 * Task 14: the onboarding funnel events.
 *
 * Most of the twelve funnel steps are covered by other suites already
 * (first_launch, persona_selected, agent_connected, onboarding_piece_built —
 * all pre-existing). This file is the contract for the eight NEW ones:
 *   - every name is on the allow-list (routes reject anything that isn't)
 *   - `reason` is mapped through a bounded classifier that can never leak a
 *     filesystem path (the installer's raw error text routinely has one)
 *   - `first_message_sent` fires exactly once per install, through the
 *     mark-once milestone route's own primitive — never once per message.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EVENT_NAMES, isEventName } from "@/lib/analytics/events";
import { installFailureReason } from "@/lib/agents/runtime-install";
import { createTestDb } from "@/__tests__/helpers/test-db";
import type { SessionEntry } from "@/lib/sessions/types";

const sm = {
  getSession: vi.fn<(id: string) => SessionEntry | undefined>(),
  hasActiveSession: vi.fn<(id: string) => boolean>(),
  activateSession: vi.fn(async () => []),
  sendMessage: vi.fn(async () => {}),
};
vi.mock("@/lib/sessions/session-manager", () => ({
  getSessionManager: () => sm,
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (name: string, params?: Record<string, unknown>) =>
    trackServerEvent(name, params),
}));

describe("funnel events — allow-list", () => {
  it("adds every funnel event to the allow-list", () => {
    for (const n of [
      "persona_prompt_shown",
      "agent_connect_shown",
      "agent_setup_started",
      "agent_setup_command_copied",
      "agent_install_completed",
      "agent_install_failed",
      "agent_sign_in_opened",
      "first_message_sent",
    ]) {
      expect(isEventName(n)).toBe(true);
    }
  });

  it("keeps every event name within GA4's limit", () => {
    for (const n of EVENT_NAMES) expect(n.length).toBeLessThanOrEqual(40);
  });
});

describe("installFailureReason — bounded, never a path", () => {
  it("maps installer errors onto a bounded reason, never the raw text", () => {
    expect(
      installFailureReason("npm ERR! code E404 at /Users/nadav/.libi/agents"),
    ).toBe("npm_failed");
    expect(installFailureReason("who knows")).toBe("unknown");
    // A path must never survive into an event param.
    for (const raw of ["/Users/someone/secret", "C:\\Users\\me\\x"]) {
      expect(installFailureReason(raw)).not.toContain("/");
      expect(installFailureReason(raw)).not.toContain("\\");
    }
  });

  it("recognizes cancellation, timeout, drift, and the native-binary trap — the real strings the installer produces", () => {
    // Exact string the runner throws on ctx.shouldCancel().
    expect(installFailureReason("cancelled")).toBe("cancelled");
    // lib/install/npm-root.ts's own timeout wording.
    expect(
      installFailureReason(
        "Command failed: node npm.js install --no-save — timed out after 1800000ms",
      ),
    ).toBe("timeout");
    // claudeNativeBinaryMissingError()'s real message embeds an absolute
    // path (`${root}`) — the classifier must still land on the bounded
    // verdict, discarding the path entirely.
    expect(
      installFailureReason(
        "the Claude native binary for darwin-arm64 is missing from /Users/x/.libi/agents " +
          "(@anthropic-ai/claude-agent-sdk-darwin-arm64 did not install). npm exits 0 …",
      ),
    ).toBe("native_binary_missing");
    // describeDrift()'s real "expected X, got Y" shape.
    expect(
      installFailureReason(
        "@agentclientprotocol/claude-agent-acp: expected 0.1.2, got 0.1.1",
      ),
    ).toBe("version_drift");
  });

  it("buckets a genuine npm failure as npm_failed even when its stderr contains the word 'cancelled'", () => {
    // Real ECONNRESET-style npm wording — the registry request was itself
    // cancelled/reset, which has nothing to do with the USER cancelling the
    // install. If "cancelled" were checked before the npm-specific signal,
    // this would misclassify a real failure as a user cancellation.
    expect(
      installFailureReason(
        "Command failed: node npm.js install --no-save\n" +
          "npm ERR! code ECONNRESET\n" +
          "npm ERR! network request to https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk failed, reason: request cancelled",
      ),
    ).toBe("npm_failed");
  });
});

describe("first_message_sent — mark-once through the milestone, not per message", () => {
  beforeEach(() => {
    createTestDb();
    trackServerEvent.mockClear();
    sm.getSession.mockReset();
    sm.hasActiveSession.mockReset();
    sm.activateSession.mockReset();
    sm.sendMessage.mockReset();
    sm.getSession.mockReturnValue({ sessionId: "s1", agentId: "claude-code" } as SessionEntry);
    sm.hasActiveSession.mockReturnValue(true);
    sm.activateSession.mockResolvedValue([]);
    sm.sendMessage.mockResolvedValue(undefined);
  });

  it("fires first_message_sent through the mark-once milestone, not per message", async () => {
    const { POST } = await import("@/app/api/agent/send/route");
    const req = (text: string) =>
      new Request("http://x/api/agent/send", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", text }),
      });

    const first = await POST(req("hello"));
    const second = await POST(req("and again"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Otherwise it counts messages, and the funnel step becomes meaningless.
    const fired = trackServerEvent.mock.calls.filter(([name]) => name === "first_message_sent");
    expect(fired.length).toBe(1);
  });
});
