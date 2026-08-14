import { vi, describe, it, expect } from "vitest";

// detectInstalledAgents calls execSync — mock it to avoid spawning real
// processes. Keep every other export (execFile, etc.) intact via
// importOriginal: agent-registry.ts now transitively imports
// lib/install/npm-root.ts (via lib/agents/runtime-install.ts), which calls
// `promisify(execFile)` at module-import time and would throw if execFile
// were missing from the mock.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => {
      throw new Error("not found");
    }),
  };
});

import { getProviderInfos } from "@/lib/agents/provider-registry";

describe("getProviderInfos", () => {
  it("returns an array of provider infos", () => {
    const infos = getProviderInfos();
    expect(Array.isArray(infos)).toBe(true);
    expect(infos.length).toBe(2);
  });

  it("contains claude-code provider", () => {
    const infos = getProviderInfos();
    expect(infos.some((p) => p.id === "claude-code")).toBe(true);
  });

  it("contains codex provider", () => {
    const infos = getProviderInfos();
    expect(infos.some((p) => p.id === "codex")).toBe(true);
  });

  it("does not contain gemini-cli provider", () => {
    const infos = getProviderInfos();
    expect(infos.some((p) => p.id === "gemini-cli")).toBe(false);
  });

  it("all providers have type acp", () => {
    const infos = getProviderInfos();
    for (const info of infos) {
      expect(info.type).toBe("acp");
    }
  });

  it("does not contain claude-api provider", () => {
    const infos = getProviderInfos();
    expect(infos.some((p) => p.id === "claude-api")).toBe(false);
  });

  it("does not contain openai-api provider", () => {
    const infos = getProviderInfos();
    expect(infos.some((p) => p.id === "openai-api")).toBe(false);
  });
});

/**
 * The reason has to survive the mapping into AgentProviderInfo — a reason that
 * exists only on CliAgentConfig never reaches the selector, which is where the
 * whole point of it (an explained, disabled row rather than a vanished agent)
 * lives.
 *
 * This used to force codex unavailable by making `execSync` throw, with a
 * comment claiming codex "still gates on `which`". That was already untrue —
 * it gated on `execSync('test -x …')` against the bundled adapter — and it is
 * doubly untrue now that the probe is a filesystem check. Neither agent's
 * availability is decided by anything this suite controls, so the assertion is
 * on the INVARIANT (an unavailable provider always explains itself) rather
 * than on which providers happen to be unavailable in this checkout.
 */
describe("getProviderInfos — unavailability reasons", () => {
  it("carries a reason on every unavailable provider", () => {
    const unavailable = getProviderInfos().filter((p) => !p.available);
    for (const info of unavailable) {
      expect(info.unavailableReason, info.id).toBeDefined();
      expect(info.unavailableReason!.message.length).toBeGreaterThan(0);
      expect(["installing", "install_failed", "not_installed"]).toContain(
        info.unavailableReason!.code,
      );
    }
  });

  it("never carries a reason on an AVAILABLE provider", () => {
    // The inverse is the part a stale reason would break: a row that works but
    // renders an explanation for why it doesn't.
    for (const info of getProviderInfos().filter((p) => p.available)) {
      expect(info.unavailableReason, info.id).toBeUndefined();
    }
  });
});
