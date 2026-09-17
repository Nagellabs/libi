import { vi, describe, it, expect, beforeEach } from "vitest";
import type { CliAgentConfig } from "@/lib/agents/acp/agent-registry";

// detectInstalledAgents calls execSync — mock it to avoid spawning real
// processes. Keep every other export (execFile, etc.) intact via
// importOriginal: agent-registry.ts transitively imports
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

// Real detection by default; a test can pin the adapter half with `detected`.
let detected: CliAgentConfig[] | null = null;
vi.mock("@/lib/agents/acp/agent-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/acp/agent-registry")>();
  return { ...actual, detectInstalledAgents: () => detected ?? actual.detectInstalledAgents() };
});

// The CLI half. Never a real login-shell probe in a unit test (CI has no claude/codex).
const USABLE = { path: "/u/bin/cli", realPath: "/u/bin/cli", execPath: "/u/bin/cli", version: "9.0.0", meetsMinimum: true };
let resolved: unknown = USABLE;
const resolveAgentCli = vi.fn(async (_agentId: string, _deps?: { staleOk?: boolean }) => resolved);
vi.mock("@/lib/agents/cli/resolve", () => ({
  resolveAgentCli: (agentId: string, deps?: { staleOk?: boolean }) => resolveAgentCli(agentId, deps),
  isUsableCli: (r: { meetsMinimum?: boolean } | null) => !!r && "meetsMinimum" in r && r.meetsMinimum === true,
}));

import { getProviderInfos } from "@/lib/agents/provider-registry";

const adapter = (id: string, name: string, installed: boolean): CliAgentConfig => ({
  id,
  name,
  command: installed ? `/bin/${id}-acp` : "",
  args: [],
  detectCommand: id === "codex" ? "codex" : "claude",
  envHints: [],
  installed,
  ...(installed ? {} : { unavailableReason: { code: "not_installed" as const, message: `${name} support isn't downloaded yet — set it up in Agents.` } }),
});

beforeEach(() => {
  detected = null;
  resolved = USABLE;
  resolveAgentCli.mockClear();
});

describe("getProviderInfos", () => {
  it("returns an array of provider infos", async () => {
    const infos = await getProviderInfos();
    expect(Array.isArray(infos)).toBe(true);
    expect(infos.length).toBe(2);
  });

  it("contains claude-code provider", async () => {
    const infos = await getProviderInfos();
    expect(infos.some((p) => p.id === "claude-code")).toBe(true);
  });

  it("contains codex provider", async () => {
    const infos = await getProviderInfos();
    expect(infos.some((p) => p.id === "codex")).toBe(true);
  });

  it("does not contain gemini-cli provider", async () => {
    const infos = await getProviderInfos();
    expect(infos.some((p) => p.id === "gemini-cli")).toBe(false);
  });

  it("all providers have type acp", async () => {
    const infos = await getProviderInfos();
    for (const info of infos) {
      expect(info.type).toBe("acp");
    }
  });

  it("does not contain claude-api provider", async () => {
    const infos = await getProviderInfos();
    expect(infos.some((p) => p.id === "claude-api")).toBe(false);
  });

  it("does not contain openai-api provider", async () => {
    const infos = await getProviderInfos();
    expect(infos.some((p) => p.id === "openai-api")).toBe(false);
  });
});

/**
 * The reason has to survive the mapping into AgentProviderInfo — a reason that
 * exists only on CliAgentConfig never reaches the selector, which is where the
 * whole point of it (an explained, disabled row rather than a vanished agent)
 * lives. Asserted on the INVARIANT (an unavailable provider always explains
 * itself) rather than on which providers happen to be unavailable in this
 * checkout.
 */
describe("getProviderInfos — unavailability reasons", () => {
  it("carries a reason on every unavailable provider", async () => {
    const unavailable = (await getProviderInfos()).filter((p) => !p.available);
    for (const info of unavailable) {
      expect(info.unavailableReason, info.id).toBeDefined();
      expect(info.unavailableReason!.message.length).toBeGreaterThan(0);
      expect(["installing", "install_failed", "not_installed"]).toContain(
        info.unavailableReason!.code,
      );
    }
  });

  it("never carries a reason on an AVAILABLE provider", async () => {
    // The inverse is the part a stale reason would break: a row that works but
    // renders an explanation for why it doesn't.
    for (const info of (await getProviderInfos()).filter((p) => p.available)) {
      expect(info.unavailableReason, info.id).toBeUndefined();
    }
  });
});

describe("getProviderInfos — available = adapter installed AND the user's CLI usable", () => {
  it("an agent whose adapter is installed but whose CLI is missing is available: false with the Agents reason", async () => {
    detected = [adapter("claude-code", "Claude Code", true), adapter("codex", "Codex", true)];
    resolved = null;

    const infos = await getProviderInfos();

    expect(infos.find((p) => p.id === "claude-code")).toMatchObject({
      available: false,
      unavailableReason: { code: "not_installed", message: "Claude Code isn't set up yet — open Agents to install it." },
    });
    expect(infos.find((p) => p.id === "codex")).toMatchObject({
      available: false,
      unavailableReason: { code: "not_installed", message: "Codex isn't set up yet — open Agents to install it." },
    });
  });

  it("an outdated CLI is unavailable too, naming its version", async () => {
    detected = [adapter("claude-code", "Claude Code", true)];
    resolved = { ...USABLE, version: "1.0.0", meetsMinimum: false };

    const [info] = await getProviderInfos();

    expect(info.available).toBe(false);
    expect(info.unavailableReason?.message).toBe("Claude Code 1.0.0 is older than libi needs — open Agents to update it.");
  });

  it("adapter installed + usable CLI → available, with no reason", async () => {
    detected = [adapter("codex", "Codex", true)];

    const [info] = await getProviderInfos();

    expect(info.available).toBe(true);
    expect(info.unavailableReason).toBeUndefined();
  });

  it("resolves both agents' CLIs concurrently, and never from a stale memo (no staleOk)", async () => {
    detected = [adapter("claude-code", "Claude Code", true), adapter("codex", "Codex", true)];
    const releases: Array<() => void> = [];
    const gated = () => new Promise<unknown>((resolve) => releases.push(() => resolve(USABLE)));
    resolveAgentCli.mockImplementationOnce(gated).mockImplementationOnce(gated);

    const pending = getProviderInfos();
    // Both resolutions start before either settles.
    await vi.waitFor(() => expect(resolveAgentCli).toHaveBeenCalledTimes(2));
    releases.forEach((release) => release());
    const infos = await pending;

    expect(infos.map((p) => p.id)).toEqual(["claude-code", "codex"]);
    expect(infos.every((p) => p.available)).toBe(true);
    for (const [, deps] of resolveAgentCli.mock.calls) expect(deps?.staleOk).toBeFalsy();
  });

  it("an adapter that is not installed keeps the adapter's reason, and the CLI is never resolved for it", async () => {
    detected = [adapter("codex", "Codex", false)];

    const [info] = await getProviderInfos();

    expect(info.available).toBe(false);
    expect(info.unavailableReason?.message).toBe("Codex support isn't downloaded yet — set it up in Agents.");
    expect(resolveAgentCli).not.toHaveBeenCalled();
  });
});
