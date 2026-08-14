import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { getApprovalMode, setApprovalMode } from "@/lib/approval/settings";
import { updateSettings } from "@/lib/db/settings";

beforeEach(() => {
  createTestDb();
});

afterEach(() => {
  resetTestDb();
});

describe("approval settings", () => {
  it("returns default 'auto' when nothing is stored", () => {
    expect(getApprovalMode("unknown")).toBe("auto");
  });

  it("round-trips a set value", () => {
    setApprovalMode("claude-code", "ask");
    expect(getApprovalMode("claude-code")).toBe("ask");
  });

  it("keeps per-agent values independent", () => {
    setApprovalMode("claude-code", "ask");
    setApprovalMode("codex", "auto-with-generations");
    expect(getApprovalMode("claude-code")).toBe("ask");
    expect(getApprovalMode("codex")).toBe("auto-with-generations");
    // Setting one didn't change the default for an unrelated agent.
    expect(getApprovalMode("gemini")).toBe("auto");
  });

  it("survives corrupt JSON in storage and recovers on next set", () => {
    updateSettings({ agentApprovalModes: "{not json" });
    // Reading falls back to default.
    expect(getApprovalMode("anything")).toBe("auto");
    expect(getApprovalMode("claude-code")).toBe("auto");

    // Writing recovers — subsequent reads see the new value, no leftover garbage.
    setApprovalMode("claude-code", "ask");
    expect(getApprovalMode("claude-code")).toBe("ask");
    expect(getApprovalMode("anything")).toBe("auto");
  });

  it("filters out invalid per-agent values written directly", () => {
    updateSettings({
      agentApprovalModes: JSON.stringify({ "agent-a": "ask", "agent-b": "bogus" }),
    });
    expect(getApprovalMode("agent-a")).toBe("ask");
    // Invalid value falls back to default.
    expect(getApprovalMode("agent-b")).toBe("auto");
  });
});
