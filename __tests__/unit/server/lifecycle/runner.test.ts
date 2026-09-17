import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInstallPhase, runBootPhase } from "@/lib/server/lifecycle/runner";
import { testAdapter } from "@/lib/server/lifecycle/adapters/test";
import { __resetLifecycleEventsForTests, lifecycleEvents } from "@/lib/server/lifecycle/events";
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
// Category B fires the disk-housekeeping sweep for real: without this mock
// the suite would prune the developer's actual `~/Library/Caches/ms-playwright`.
vi.mock("@/lib/server/lifecycle/housekeeping", () => ({
  runBootHousekeeping: vi.fn(async () => {}),
}));

const baseADeps: CategoryADeps = {
  installBinaryDeps: async () => {},
  ensureNodeRuntime: async () => ({ ok: true, path: "/fake/bin/node", source: "already-managed" }),
};

const baseBDeps: CategoryBDeps = {
  migrateDatabase: () => {},
  recoverOrphanedJobs: async () => {},
  writePortFile: () => {},
  startMcpHttp: async () => {},
  prepareAgentDir: async () => {},
  warmAgentProcess: async () => {},
  loadSessions: async () => {},
  probeAndPersist: async () => {},
  createStandby: async () => {},
  syncSkillInstalls: async () => {},
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
        // Throwing from installBinaryDeps — the one fatal phase left in
        // category-a.ts, which wraps it into
        // InstallPhaseError("binary-install", "Failed to install bundled binary deps: <msg>", …).
        installBinaryDeps: async () => {
          throw new Error("ENETUNREACH");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.fatal?.phase).toBe("category-a");
    expect(result.fatal?.step).toBe("binary-install");
    expect(result.fatal?.error).toContain("ENETUNREACH");

    const fatal = adapter.captured().find((e) => e.kind === "fatal");
    expect(fatal).toBeTruthy();
    if (fatal?.kind === "fatal") {
      expect(fatal.phase).toBe("category-a");
      expect(fatal.step).toBe("binary-install");
    }
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

  it("keeps handing the adapter boot warnings, and only warnings, after a successful install phase", async () => {
    // Category B runs later in the same process for npx and the desktop app,
    // with no adapter of its own; the splash or the terminal is still up.
    const adapter = testAdapter();
    await runInstallPhase({ adapter, deps: baseADeps });
    const before = adapter.captured().length;

    lifecycleEvents.emit({ kind: "category-b-step", step: "mcp-http", status: "running" });
    const warning = { kind: "warning", phase: "category-b", step: "mcp-http", message: "tools unavailable" } as const;
    lifecycleEvents.emit(warning);
    lifecycleEvents.emit({ kind: "category-b-step", step: "mcp-http", status: "done" });

    expect(adapter.captured().slice(before)).toEqual([warning]);
  });

  it("forwards no boot warnings after an install phase that failed", async () => {
    const adapter = testAdapter();
    await runInstallPhase({
      adapter,
      deps: {
        ...baseADeps,
        installBinaryDeps: async () => {
          throw new Error("ENETUNREACH");
        },
      },
    });
    const before = adapter.captured().length;
    lifecycleEvents.emit({ kind: "warning", phase: "category-b", step: "mcp-http", message: "tools unavailable" });
    expect(adapter.captured().length).toBe(before);
  });
});

describe("runBootPhase", () => {
  beforeEach(() => {
    __resetLifecycleEventsForTests();
    vi.stubEnv("NODE_ENV", "test");
  });

  it("returns { ok: true } on happy path", async () => {
    const adapter = testAdapter();
    const result = await runBootPhase({ adapter, deps: baseBDeps });

    expect(result.ok).toBe(true);
    expect(result.fatal).toBeUndefined();
  });

  it("emits category-b-step events for db-migrate, jobs-recover, port-file", async () => {
    const adapter = testAdapter();
    await runBootPhase({ adapter, deps: baseBDeps });

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
