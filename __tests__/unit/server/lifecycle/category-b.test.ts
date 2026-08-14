import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCategoryB, BootPhaseError } from "@/lib/server/lifecycle/category-b";
import { lifecycleEvents } from "@/lib/server/lifecycle/events";
import type { CategoryBDeps } from "@/lib/server/lifecycle/category-b";
import type { LifecycleEvent } from "@/lib/server/lifecycle/types";

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

const baseDeps: CategoryBDeps = {
  migrateDatabase: () => {},
  recoverOrphanedJobs: async () => {},
  writePortFile: () => {},
  prepareAgentDir: async (_dir: string) => {},
  warmAgentProcess: async () => {},
  loadSessions: async () => {},
  probeAndPersist: async () => {},
  createStandby: async () => {},
};

describe("runCategoryB", () => {
  let events: LifecycleEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = lifecycleEvents.on((e) => events.push(e));
    delete process.env.LIBI_CONNECT_AGENT_DIR;
  });

  afterEach(() => {
    unsubscribe();
    delete process.env.LIBI_CONNECT_AGENT_DIR;
  });

  it("emits step events for db-migrate / jobs-recover / port-file in order", async () => {
    await runCategoryB(baseDeps);
    const steps = events
      .filter((e) => e.kind === "category-b-step")
      .map((e) => {
        const ev = e as Extract<LifecycleEvent, { kind: "category-b-step" }>;
        return `${ev.step}:${ev.status}`;
      });

    expect(steps).toContain("db-migrate:running");
    expect(steps).toContain("db-migrate:done");
    expect(steps.indexOf("db-migrate:done")).toBeLessThan(steps.indexOf("jobs-recover:running"));
    expect(steps.indexOf("jobs-recover:done")).toBeLessThan(steps.indexOf("port-file:running"));
  });

  it("throws BootPhaseError on db-migrate failure with hint", async () => {
    await expect(
      runCategoryB({
        ...baseDeps,
        migrateDatabase: () => { throw new Error("malformed schema"); },
      }),
    ).rejects.toMatchObject({ name: "BootPhaseError", step: "db-migrate" });
  });

  it("throws BootPhaseError on jobs-recover failure", async () => {
    await expect(
      runCategoryB({
        ...baseDeps,
        recoverOrphanedJobs: async () => { throw new Error("jobs dir corrupt"); },
      }),
    ).rejects.toMatchObject({ name: "BootPhaseError", step: "jobs-recover" });
  });

  it("short-circuits after agent-dir prep in connect-agent mode, prepping BOTH dirs", async () => {
    process.env.LIBI_CONNECT_AGENT_DIR = "/tmp/libi-connect-test";
    let warmed = false;
    const prepared: string[] = [];
    await runCategoryB({
      ...baseDeps,
      prepareAgentDir: async (dir: string) => { prepared.push(dir); },
      warmAgentProcess: async () => { warmed = true; },
    });
    expect(warmed).toBe(false);
    expect(prepared).toHaveLength(2);
    expect(prepared[1]).toBe("/tmp/libi-connect-test");
    expect(events.some((e) => e.kind === "category-b-done")).toBe(true);
  });

  it("emits category-b-done on the happy path (no preferred agent)", async () => {
    // With baseDeps and no preferred agent in the test DB, Category B
    // skips Phase 3 onwards and emits category-b-done after the workspace
    // prep.
    await runCategoryB(baseDeps);
    expect(events.some((e) => e.kind === "category-b-done")).toBe(true);
  });
});
