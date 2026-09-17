import { describe, it, expect, vi } from "vitest";
// Every collaborator is injected through `deps`; the real modules are mocked away so this
// unit test never pulls in the session manager or the DB.
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => ({ getReadiness: () => ({ state: "unknown" }) }) }));
vi.mock("@/lib/agents/acp/agent-registry", () => ({ getAgentConfig: () => undefined }));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ getSignInConfirmedAt: () => null }));
const detectLibiRegistrationMock = vi.fn(async (deps?: { only?: string; refresh?: boolean; checkAgain?: boolean }) => {
  void deps;
  return {} as Record<string, { state: string }>;
});
vi.mock("@/lib/agents/libi-registration", () => ({
  detectLibiRegistration: (deps?: { only?: string; refresh?: boolean; checkAgain?: boolean }) => detectLibiRegistrationMock(deps),
}));
vi.mock("@/lib/agents/cli/resolve", () => ({ resolveAgentCli: async () => null }));
import { adapterStateFrom, buildAgentStatus, cliUnavailableReason } from "@/lib/agents/agent-status";
import { cliUnavailableReason as leafCliUnavailableReason } from "@/lib/agents/cli/unavailable-reason";

describe("adapterStateFrom", () => {
  it("maps the registry's vocabulary onto the four adapter states", () => {
    expect(adapterStateFrom({ installed: true })).toBe("ready");
    expect(adapterStateFrom({ installed: false, unavailableReason: { code: "installing" } })).toBe("installing");
    expect(adapterStateFrom({ installed: false, unavailableReason: { code: "install_failed" } })).toBe("failed");
    expect(adapterStateFrom({ installed: false, unavailableReason: { code: "not_installed" } })).toBe("missing");
    expect(adapterStateFrom(undefined)).toBe("missing");
  });
});

describe("cliUnavailableReason (re-exported from the leaf module)", () => {
  it("is the leaf's function, not a copy", () => {
    expect(cliUnavailableReason).toBe(leafCliUnavailableReason);
  });

  it("null only for a usable CLI; every other shape names Agents", () => {
    const usable = { path: "/u/bin/codex", realPath: "/u/bin/codex", execPath: "/u/bin/codex", version: "9.0.0", meetsMinimum: true };
    expect(cliUnavailableReason("codex", usable)).toBeNull();
    for (const cli of [null, { foundButBroken: true as const, path: "/u/bin/codex" }, { ...usable, meetsMinimum: false }]) {
      expect(cliUnavailableReason("codex", cli)?.message).toMatch(/open Agents/);
    }
  });

  it("uses the display name, never the raw id", () => {
    expect(cliUnavailableReason("claude-code", null)?.message).toBe("Claude Code isn't set up yet — open Agents to install it.");
  });
});

describe("buildAgentStatus", () => {
  const usable = { path: "/u/bin/claude", realPath: "/u/bin/claude", execPath: "/u/bin/claude", version: "2.1.250", meetsMinimum: true };
  const base = {
    resolveCli: async () => usable,
    adapterConfig: () => ({ installed: true }),
    signInConfirmedAt: () => new Date("2026-09-10T10:00:00Z"),
    readinessState: () => "ready" as const,
    libiRegistration: async () => ({ "claude-code": { state: "connected" as const, scope: "user" as const }, codex: { state: "connected" as const, scope: "user" as const } }),
  };

  it("ready = usable CLI + ready adapter; keeps realPath (what printed commands use) and strips execPath from the wire shape", async () => {
    const s = await buildAgentStatus("claude-code", base);
    expect(s).toEqual({
      agentId: "claude-code",
      cli: { path: "/u/bin/claude", realPath: "/u/bin/claude", version: "2.1.250", meetsMinimum: true },
      adapter: "ready",
      signIn: { confirmedAt: "2026-09-10T10:00:00.000Z", needsAuth: false },
      libiTools: { state: "connected", scope: "user" },
      ready: true,
    });
  });

  it("no CLI → cli null, libiTools not-connected (without reading any registration), ready false", async () => {
    const libiRegistration = vi.fn(base.libiRegistration);
    const s = await buildAgentStatus("codex", { ...base, libiRegistration, resolveCli: async () => null });
    expect(s.cli).toBeNull();
    expect(s.libiTools).toEqual({ state: "not-connected" });
    expect(s.ready).toBe(false);
    expect(libiRegistration).not.toHaveBeenCalled();
  });

  it("asks the registration for THIS agent only (a Claude poll never spawns codex)", async () => {
    const libiRegistration = vi.fn(base.libiRegistration);
    await buildAgentStatus("claude-code", { ...base, libiRegistration });
    expect(libiRegistration).toHaveBeenCalledWith("claude-code");
  });

  it("below the minimum or broken → not ready, even with a ready adapter", async () => {
    expect((await buildAgentStatus("claude-code", { ...base, resolveCli: async () => ({ ...usable, meetsMinimum: false }) })).ready).toBe(false);
    expect((await buildAgentStatus("claude-code", { ...base, resolveCli: async () => ({ foundButBroken: true, path: "/u/bin/claude" }) })).cli).toEqual({ foundButBroken: true, path: "/u/bin/claude" });
  });

  it("an observed needs-auth wins over a stored confirmation", async () => {
    const s = await buildAgentStatus("claude-code", { ...base, readinessState: () => "needs-auth" });
    expect(s.signIn).toEqual({ confirmedAt: "2026-09-10T10:00:00.000Z", needsAuth: true });
  });

  it("scope is present for Claude only", async () => {
    // The codex fixture DOES carry a scope, so the assertion proves it is stripped.
    const s = await buildAgentStatus("codex", { ...base, libiRegistration: async () => ({ "claude-code": { state: "not-connected" }, codex: { state: "stale-port", scope: "user", url: "http://127.0.0.1:1/mcp" } }) });
    expect(s.libiTools).toEqual({ state: "stale-port" });
  });

  it("carries the registration's stale flag through to libiTools, so the wizard can see a last-known answer", async () => {
    const s = await buildAgentStatus("codex", {
      ...base,
      libiRegistration: async () => ({ "claude-code": { state: "not-connected" }, codex: { state: "connected", stale: true as const } }),
    });
    expect(s.libiTools).toEqual({ state: "connected", stale: true });
  });

  it("no stale key at all when the registration isn't stale — never `stale: false`", async () => {
    const s = await buildAgentStatus("claude-code", base);
    expect(s.libiTools).not.toHaveProperty("stale");
  });

  it("threads refresh through to the default detectLibiRegistration call, for Check again — and checkAgain too: buildAgentStatus's refresh is only ever Check again", async () => {
    detectLibiRegistrationMock.mockResolvedValueOnce({ codex: { state: "connected" } });
    await buildAgentStatus("codex", { ...base, libiRegistration: undefined, refresh: true });
    expect(detectLibiRegistrationMock).toHaveBeenCalledWith({ only: "codex", refresh: true, checkAgain: true });
  });

  it("a plain read (no Check again) passes refresh and checkAgain as undefined", async () => {
    detectLibiRegistrationMock.mockResolvedValueOnce({ codex: { state: "connected" } });
    await buildAgentStatus("codex", { ...base, libiRegistration: undefined });
    expect(detectLibiRegistrationMock).toHaveBeenCalledWith({ only: "codex", refresh: undefined, checkAgain: undefined });
  });
});
