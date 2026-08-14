import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInstallPhase, runBootPhase } from "@/lib/server/lifecycle/runner";
import { testAdapter } from "@/lib/server/lifecycle/adapters/test";
import { __resetLifecycleEventsForTests } from "@/lib/server/lifecycle/events";
import { BootPhaseError } from "@/lib/server/lifecycle/category-b";
import type { CategoryADeps } from "@/lib/server/lifecycle/category-a";
import type { CategoryBDeps } from "@/lib/server/lifecycle/category-b";

// Stub out modules that would require a real DB / agent process in tests.
vi.mock("@/lib/db/settings", () => ({
  getSettings: vi.fn(() => ({ preferredAgent: null })),
}));
vi.mock("@/lib/agents/acp/agent-registry", () => ({
  getAgentConfig: vi.fn(() => null),
}));
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: vi.fn(),
}));

const baseADeps: CategoryADeps = {
  ensureBundledNpm: async () => {},
  installBinaryDeps: async () => {},
  probeMcp: async () => ({ status: "up", error: null, durationMs: 5 }),
  defs: () => [],
  ensureNodeRuntime: async () => ({ ok: true, path: "/fake/bin/node", source: "already-managed" }),
  ensureClaudeAdapter: async () => ({ installed: true, binPath: "/fake/bin/claude-agent-acp" }),
};

const baseBDeps: CategoryBDeps = {
  migrateDatabase: () => {},
  recoverOrphanedJobs: async () => {},
  writePortFile: () => {},
  prepareAgentDir: async () => {},
  warmAgentProcess: async () => {},
  loadSessions: async () => {},
  probeAndPersist: async () => {},
  createStandby: async () => {},
};

describe("runInstallPhase", () => {
  beforeEach(() => {
    __resetLifecycleEventsForTests();
  });

  it("returns { ok: true } and emits prelude-start + category-a-done on success", async () => {
    const adapter = testAdapter();
    const result = await runInstallPhase({ adapter, deps: baseADeps });

    expect(result.ok).toBe(true);
    expect(result.fatal).toBeUndefined();

    const kinds = adapter.captured().map((e) => e.kind);
    expect(kinds).toContain("prelude-start");
    expect(kinds).toContain("category-a-done");
  });

  it("returns { ok: false } and emits fatal when category A throws InstallPhaseError", async () => {
    const adapter = testAdapter();
    const result = await runInstallPhase({
      adapter,
      deps: {
        ...baseADeps,
        // Throwing from ensureBundledNpm — category-a.ts wraps it into
        // InstallPhaseError("npm-install", "Failed to install bundled MCP npm packages: <msg>", …).
        ensureBundledNpm: async () => {
          throw new Error("ENETUNREACH");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.fatal?.phase).toBe("category-a");
    expect(result.fatal?.step).toBe("npm-install");
    expect(result.fatal?.error).toContain("ENETUNREACH");

    const fatal = adapter.captured().find((e) => e.kind === "fatal");
    expect(fatal).toBeTruthy();
    if (fatal?.kind === "fatal") {
      expect(fatal.phase).toBe("category-a");
      expect(fatal.step).toBe("npm-install");
    }
  });

  it("returns { ok: false } and emits fatal when category A throws a generic error (no hint)", async () => {
    const adapter = testAdapter();
    // Throw an InstallPhaseError directly (not wrapped by category-a.ts) by
    // having probeMcp return "down" — category-a.ts throws InstallPhaseError
    // with step "probe:<id>" in that path.
    const result = await runInstallPhase({
      adapter,
      deps: {
        ...baseADeps,
        probeMcp: async () => ({ status: "down", error: "timeout", durationMs: 10 }),
        defs: () => [
          {
            id: "test-mcp",
            name: "Test MCP",
            description: "",
            npmUrl: null,
            type: "stdio" as const,
            command: "echo",
            args: [],
            requireApproval: false,
            dependencies: [],
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.fatal?.phase).toBe("category-a");
    expect(result.fatal?.step).toBe("probe:test-mcp");
    expect(result.fatal?.error).toContain("timeout");
  });

  it("unsubscribes the adapter listener after completion (no event leakage)", async () => {
    const adapter = testAdapter();

    // Run one phase to completion — adapter subscribes internally, then unsubscribes.
    await runInstallPhase({ adapter, deps: baseADeps });
    const countAfterFirst = adapter.captured().length;

    // Run a second phase — adapter should NOT receive events from it.
    const adapter2 = testAdapter();
    await runInstallPhase({ adapter: adapter2, deps: baseADeps });

    // First adapter's captured list must not have grown.
    expect(adapter.captured().length).toBe(countAfterFirst);
  });
});

describe("runBootPhase", () => {
  beforeEach(() => {
    __resetLifecycleEventsForTests();
    // Ensure connect-agent mode is not set so Category B runs the full path.
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.LIBI_CONNECT_AGENT_DIR;
  });

  it("returns { ok: true } on happy path", async () => {
    const adapter = testAdapter();
    const result = await runBootPhase({ adapter, deps: baseBDeps });

    expect(result.ok).toBe(true);
    expect(result.fatal).toBeUndefined();
  });

  it("emits category-b-step events for db-migrate, jobs-recover, port-file", async () => {
    const adapter = testAdapter();
    // Use connect-agent mode to short-circuit after the fixed steps + agent-dir prep.
    process.env.LIBI_CONNECT_AGENT_DIR = "/tmp/libi-connect-test";
    try {
      await runBootPhase({ adapter, deps: baseBDeps });
    } finally {
      delete process.env.LIBI_CONNECT_AGENT_DIR;
    }

    const kinds = adapter.captured().map((e) => e.kind);
    expect(kinds).toContain("category-b-step");
    const steps = adapter
      .captured()
      .filter((e) => e.kind === "category-b-step")
      .map((e) => {
        const ev = e as Extract<typeof e, { kind: "category-b-step" }>;
        return ev.step;
      });
    expect(steps).toContain("db-migrate");
    expect(steps).toContain("jobs-recover");
    expect(steps).toContain("port-file");
  });

  it("returns { ok: false } and emits fatal on BootPhaseError", async () => {
    const adapter = testAdapter();
    const result = await runBootPhase({
      adapter,
      deps: {
        ...baseBDeps,
        recoverOrphanedJobs: async () => {
          throw new BootPhaseError(
            "jobs-recover",
            "jobs dir corrupt",
            "Inspect ~/.libi/jobs/.",
          );
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.fatal?.phase).toBe("category-b");
    expect(result.fatal?.step).toBe("jobs-recover");
    expect(result.fatal?.error).toBe("jobs dir corrupt");

    const fatal = adapter.captured().find((e) => e.kind === "fatal");
    expect(fatal).toBeTruthy();
    if (fatal?.kind === "fatal") {
      expect(fatal.phase).toBe("category-b");
    }
  });

  it("unsubscribes the adapter listener after completion (no event leakage)", async () => {
    const adapter = testAdapter();
    await runBootPhase({ adapter, deps: baseBDeps });
    const countAfterFirst = adapter.captured().length;

    const adapter2 = testAdapter();
    await runBootPhase({ adapter: adapter2, deps: baseBDeps });

    expect(adapter.captured().length).toBe(countAfterFirst);
  });
});
