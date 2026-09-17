import { describe, it, expect } from "vitest";
import { firstIncompleteStep, installedLabel, signedInLabel } from "@/components/agents-page/agents-tab/wizard-state";
import type { AgentStatus } from "@/lib/agents/agent-status";

const base: AgentStatus = {
  agentId: "claude-code",
  cli: { path: "/u/claude", realPath: "/u/claude", version: "2.1.250", meetsMinimum: true },
  adapter: "ready",
  signIn: { confirmedAt: "2026-09-10T00:00:00.000Z", needsAuth: false },
  libiTools: { state: "connected", scope: "user" },
  ready: true,
};

describe("firstIncompleteStep (never before step 2)", () => {
  it("2 when the CLI is missing, broken, or below the minimum", () => {
    expect(firstIncompleteStep({ ...base, cli: null, ready: false })).toBe(2);
    expect(firstIncompleteStep({ ...base, cli: { foundButBroken: true, path: "/x" }, ready: false })).toBe(2);
    expect(firstIncompleteStep({ ...base, cli: { ...base.cli!, meetsMinimum: false } as AgentStatus["cli"], ready: false })).toBe(2);
  });
  it("2 when the CLI is usable but the adapter is not ready — step 2 is the only place its install starts", () => {
    expect(firstIncompleteStep({ ...base, adapter: "missing", ready: false })).toBe(2);
    expect(firstIncompleteStep({ ...base, adapter: "failed", ready: false })).toBe(2);
    expect(firstIncompleteStep({ ...base, adapter: "installing", ready: false })).toBe(2);
  });
  it("3 when not confirmed or auth was observed to fail", () => {
    expect(firstIncompleteStep({ ...base, signIn: { confirmedAt: null, needsAuth: false } })).toBe(3);
    expect(firstIncompleteStep({ ...base, signIn: { confirmedAt: "2026-01-01T00:00:00.000Z", needsAuth: true } })).toBe(3);
  });
  it("4 (Open chat) once signed in, whatever libi's global registration says — connecting is optional", () => {
    expect(firstIncompleteStep(base)).toBe(4);
    expect(firstIncompleteStep({ ...base, libiTools: { state: "not-connected" } })).toBe(4);
    expect(firstIncompleteStep({ ...base, libiTools: { state: "stale-port", scope: "user" } })).toBe(4);
    expect(firstIncompleteStep({ ...base, libiTools: { state: "unknown" } })).toBe(4);
  });
});

describe("labels", () => {
  it("installedLabel", () => {
    expect(installedLabel(base.cli)).toBe("2.1.250");
    expect(installedLabel(null)).toBe("not found");
    expect(installedLabel({ ...base.cli!, meetsMinimum: false } as AgentStatus["cli"])).toBe("update needed (2.1.250)");
    expect(installedLabel({ foundButBroken: true, path: "/x" })).toBe("won't run");
  });
  it("signedInLabel: Needs sign-in > Confirmed > Not confirmed", () => {
    expect(signedInLabel({ confirmedAt: "x", needsAuth: true })).toBe("Needs sign-in");
    expect(signedInLabel({ confirmedAt: null, needsAuth: true })).toBe("Needs sign-in");
    expect(signedInLabel({ confirmedAt: "x", needsAuth: false })).toBe("Confirmed");
    expect(signedInLabel({ confirmedAt: null, needsAuth: false })).toBe("Not confirmed");
  });
});
