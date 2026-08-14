import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";

// Mocks have to be hoisted ABOVE the SUT import so the SUT picks up the
// mocked modules at evaluation time.
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/notify", () => ({
  notify: { jobProgress: vi.fn() },
  pushIfBackgrounded: vi.fn(),
}));
vi.mock("@/lib/db/settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/settings")>();
  return {
    ...original,
    getNotificationsSetting: vi.fn(() => ({ backgroundJobComplete: true })),
  };
});

import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { getJobManager } from "@/lib/jobs/manager";
import type { JobStatusSnapshot } from "@/lib/jobs/types";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pushIfBackgrounded } from "@/mcp/notify";
import { getNotificationsSetting } from "@/lib/db/settings";

function makeSnapshot(overrides: Partial<JobStatusSnapshot>): JobStatusSnapshot {
  return {
    id: "job-test",
    kind: "k_push",
    status: "completed",
    progressDone: 1,
    progressTotal: 1,
    progressUnit: "items",
    etaMs: 0,
    msPerUnit: null,
    error: null,
    resultJson: null,
    startedAt: new Date(Date.now() - 15_000),
    completedAt: new Date(),
    lastProgressAt: new Date(),
    ...overrides,
  };
}

function makeHandler(): SessionEventHandler {
  let counter = 0;
  const handler = new SessionEventHandler(
    { next: () => ++counter },
    () => {}, // emit
    () => undefined, // lookupSession
  );
  handler.attachJobProgressBridge(
    () => undefined,
    () => undefined,
  );
  return handler;
}

async function waitForMicrotasks(): Promise<void> {
  // Two awaits — the terminal handler is an async function that does
  // `await mgr.getStatus(...)`; we need to let both microtask hops settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SessionEventHandler push notification on terminal event", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
    vi.mocked(getNotificationsSetting).mockReturnValue({
      backgroundJobComplete: true,
    });
  });

  afterEach(() => {
    // Drop any listeners attached to the global JobManager singleton so
    // tests don't leak handlers across cases.
    const mgr = getJobManager();
    mgr.removeAllListeners("completed");
    mgr.removeAllListeners("failed");
  });

  it("fires push for completed job >10s with mcpToolId", async () => {
    registerRunner({
      kind: "k_push",
      mcpToolId: makeMcpToolId("libi", "libi.x"),
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });

    makeHandler();
    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({ id: "job-1", kind: "k_push" }),
    );

    mgr.emit("completed", { jobId: "job-1", result: {} });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).toHaveBeenCalledTimes(1);
    // "k_push" is NOT in the prettyTitleForKind map, so it falls back to
    // the raw kind string — this documents the fallback behavior.
    expect(pushIfBackgrounded).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "k_push",
        body: expect.stringContaining("Done"),
        jobId: "job-1",
      }),
    );
  });

  it("uses prettyTitleForKind mapping for known kinds (music_generate)", async () => {
    registerRunner({
      kind: "music_generate",
      mcpToolId: makeMcpToolId("libi", "libi.generate_music"),
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });

    makeHandler();
    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({ id: "job-music", kind: "music_generate" }),
    );

    mgr.emit("completed", { jobId: "job-music", result: {} });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Music generated",
        body: expect.stringContaining("Done"),
        jobId: "job-music",
      }),
    );
  });

  it("does not fire push when settings.backgroundJobComplete is false", async () => {
    vi.mocked(getNotificationsSetting).mockReturnValue({
      backgroundJobComplete: false,
    });

    registerRunner({
      kind: "k_off",
      mcpToolId: makeMcpToolId("libi", "libi.x"),
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });

    makeHandler();
    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({ id: "job-off", kind: "k_off" }),
    );

    mgr.emit("completed", { jobId: "job-off", result: {} });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).not.toHaveBeenCalled();
  });

  it("does not fire push when durationMs < 10s", async () => {
    registerRunner({
      kind: "k_fast",
      mcpToolId: makeMcpToolId("libi", "libi.x"),
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });

    makeHandler();
    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({
        id: "job-fast",
        kind: "k_fast",
        startedAt: new Date(Date.now() - 2_000),
        completedAt: new Date(),
      }),
    );

    mgr.emit("completed", { jobId: "job-fast", result: {} });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).not.toHaveBeenCalled();
  });

  it("does not fire push for runner without mcpToolId (proxy_gen-like)", async () => {
    registerRunner({
      kind: "k_internal",
      // intentionally no mcpToolId
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });

    makeHandler();
    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({ id: "job-internal", kind: "k_internal" }),
    );

    mgr.emit("completed", { jobId: "job-internal", result: {} });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).not.toHaveBeenCalled();
  });

  it("fires push with failure title + error body on failed event", async () => {
    registerRunner({
      kind: "music_generate",
      mcpToolId: makeMcpToolId("libi", "libi.generate_music"),
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        throw new Error("boom");
      },
    });

    makeHandler();
    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({
        id: "job-fail",
        kind: "music_generate",
        status: "failed",
        error: "boom",
      }),
    );

    mgr.emit("failed", { jobId: "job-fail", error: "boom" });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).toHaveBeenCalledTimes(1);
    expect(pushIfBackgrounded).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Music generated — failed",
        body: "boom",
        jobId: "job-fail",
      }),
    );
  });

  it("re-attaching the bridge detaches old listeners (no double-fire)", async () => {
    registerRunner({
      kind: "music_generate",
      mcpToolId: makeMcpToolId("libi", "libi.generate_music"),
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run() {
        return { ok: true };
      },
    });

    const handler = makeHandler();
    // Re-attach — simulates HMR / re-init.
    handler.attachJobProgressBridge(
      () => undefined,
      () => undefined,
    );

    const mgr = getJobManager();
    vi.spyOn(mgr, "getStatus").mockResolvedValue(
      makeSnapshot({ id: "job-once", kind: "music_generate" }),
    );

    mgr.emit("completed", { jobId: "job-once", result: {} });
    await waitForMicrotasks();

    expect(pushIfBackgrounded).toHaveBeenCalledTimes(1);
  });
});
