/**
 * /api/runtime/update — the auto-download contract.
 *
 * GET carries a side effect since the auto-download change: a check that
 * classifies `update-available` enqueues the download itself. These tests
 * pin the guards around that side effect — packaged-only, once per version
 * per process, never while staged or in flight — because a regression on
 * any of them either re-introduces click-to-download or downloads in a
 * loop. POST's shell `action: "restart"` is pinned as the apply-now path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { CurrentRuntime } from "@/lib/runtime/current-runtime";
import type { ShellUpdater, ShellUpdateStatus } from "@/lib/runtime/shell-update";
import type { UpdateStatus } from "@/lib/runtime/update-check";

const manager = {
  enqueue: vi.fn(),
  runToCompletion: vi.fn(async () => {}),
};
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => manager }));

// The route reads the latest install job straight from the DB; give it an
// in-memory answer instead of a database.
let latestJobRow: { status: string; version: string } | null = null;
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              all: () =>
                latestJobRow
                  ? [
                      {
                        id: "job-1",
                        kind: "runtime_update",
                        status: latestJobRow.status,
                        paramsJson: JSON.stringify({ version: latestJobRow.version }),
                        createdAt: 0,
                        updatedAt: 0,
                      },
                    ]
                  : [],
            }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/jobs/types", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotFromRow: (row: { id: string; status: string }) => ({
    jobId: row.id,
    status: row.status,
  }),
}));

let currentRuntime: CurrentRuntime;
vi.mock("@/lib/runtime/current-runtime", () => ({
  describeCurrentRuntime: () => currentRuntime,
}));

let pendingVersion: string | null = null;
vi.mock("@/lib/runtime/installed-runtimes", () => ({
  pendingRuntimeVersion: () => pendingVersion,
}));

let shellUpdater: ShellUpdater | null = null;
vi.mock("@/lib/runtime/shell-update", () => ({
  getShellUpdater: () => shellUpdater,
}));

let updateStatus: UpdateStatus;
vi.mock("@/lib/runtime/update-check", () => ({
  checkForRuntimeUpdate: vi.fn(async () => updateStatus),
}));

function packaged(version = "0.1.1"): CurrentRuntime {
  return {
    version,
    source: "bundled",
    shellApiVersion: 1,
    shellApi: { min: 1, max: 1 },
    updatesSupported: true,
  } as CurrentRuntime;
}

function checkResult(state: UpdateStatus["state"], latest: string | null): UpdateStatus {
  return {
    state,
    currentVersion: currentRuntime.version,
    latestVersion: latest,
    latestShellApiVersion: latest ? 1 : null,
    checkedAt: 0,
  };
}

/** Import a FRESH route module — the once-per-process guard is module state. */
async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/runtime/update/route");
}

const GET_URL = "http://x/api/runtime/update";

beforeEach(() => {
  vi.clearAllMocks();
  latestJobRow = null;
  pendingVersion = null;
  shellUpdater = null;
  currentRuntime = packaged();
  updateStatus = checkResult("update-available", "0.1.2");
  manager.enqueue.mockResolvedValue({ status: "enqueued", jobId: "job-new" });
});

describe("GET auto-download", () => {
  it("enqueues the download when a check finds an installable update", async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request(GET_URL));

    expect(manager.enqueue).toHaveBeenCalledWith("runtime_update", { version: "0.1.2" });
    expect(res.status).toBe(200);
  });

  it("downloads once per version per process — not on every poll", async () => {
    const { GET } = await loadRoute();
    await GET(new Request(GET_URL));
    await GET(new Request(GET_URL));
    await GET(new Request(GET_URL));

    expect(manager.enqueue).toHaveBeenCalledTimes(1);
  });

  it("never downloads outside the packaged app", async () => {
    currentRuntime = { ...packaged(), updatesSupported: false } as CurrentRuntime;
    const { GET } = await loadRoute();
    await GET(new Request(GET_URL));

    expect(manager.enqueue).not.toHaveBeenCalled();
  });

  it("never downloads when up to date, unknown, or shell-update-required", async () => {
    const { GET } = await loadRoute();
    for (const state of ["up-to-date", "unknown", "shell-update-required"] as const) {
      updateStatus = checkResult(state, state === "up-to-date" ? null : "0.1.2");
      await GET(new Request(GET_URL));
    }
    expect(manager.enqueue).not.toHaveBeenCalled();
  });

  it("skips a version that is already staged for the next launch", async () => {
    pendingVersion = "0.1.2";
    const { GET } = await loadRoute();
    await GET(new Request(GET_URL));

    expect(manager.enqueue).not.toHaveBeenCalled();
  });

  it("skips while a download is already in flight", async () => {
    latestJobRow = { status: "running", version: "0.1.2" };
    const { GET } = await loadRoute();
    await GET(new Request(GET_URL));

    expect(manager.enqueue).not.toHaveBeenCalled();
  });

  it("reports the download it just started in the same response", async () => {
    const { GET } = await loadRoute();
    // After the enqueue, the DB shows the new running job.
    manager.enqueue.mockImplementation(async () => {
      latestJobRow = { status: "running", version: "0.1.2" };
      return { status: "enqueued", jobId: "job-new" };
    });
    const res = await GET(new Request(GET_URL));
    const dto = (await res.json()) as { install: { status: string } | null };

    expect(dto.install?.status).toBe("running");
  });

  it("re-runs a previously failed attempt instead of replaying its outcome", async () => {
    // matching_completed = a past attempt (here: failed) with these params.
    manager.enqueue
      .mockResolvedValueOnce({ status: "matching_completed", existingJob: { jobId: "job-old" } })
      .mockResolvedValueOnce({ status: "enqueued", jobId: "job-retry" });
    const { GET } = await loadRoute();
    await GET(new Request(GET_URL));

    expect(manager.enqueue).toHaveBeenCalledTimes(2);
    expect(manager.enqueue).toHaveBeenLastCalledWith(
      "runtime_update",
      { version: "0.1.2" },
      { forceNew: true },
    );
    expect(manager.runToCompletion).toHaveBeenCalledWith("job-retry");
  });
});

describe("POST shell restart", () => {
  function shellStatus(overrides: Partial<ShellUpdateStatus>): ShellUpdateStatus {
    return {
      phase: "ready",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      percent: 100,
      error: null,
      checkedAt: 0,
      autoDownload: true,
      ...overrides,
    };
  }

  function post(body: unknown) {
    return new Request(GET_URL, { method: "POST", body: JSON.stringify(body) });
  }

  it("applies a ready download via restart()", async () => {
    const restart = vi.fn();
    shellUpdater = {
      getStatus: () => shellStatus({}),
      checkNow: vi.fn(async () => {}),
      download: vi.fn(),
      restart,
    };
    const { POST } = await loadRoute();
    const res = await POST(post({ version: "0.2.0", target: "shell", action: "restart" }));

    expect(res.status).toBe(200);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(shellUpdater.download).not.toHaveBeenCalled();
  });

  it("falls back to download() on shells without restart()", async () => {
    shellUpdater = {
      getStatus: () => shellStatus({}),
      checkNow: vi.fn(async () => {}),
      download: vi.fn(),
    };
    const { POST } = await loadRoute();
    const res = await POST(post({ version: "0.2.0", target: "shell", action: "restart" }));

    expect(res.status).toBe(200);
    expect(shellUpdater.download).toHaveBeenCalledTimes(1);
  });

  it("refuses to restart into a version that is not the ready one", async () => {
    const restart = vi.fn();
    shellUpdater = {
      getStatus: () => shellStatus({ phase: "downloading", percent: 40 }),
      checkNow: vi.fn(async () => {}),
      download: vi.fn(),
      restart,
    };
    const { POST } = await loadRoute();
    const res = await POST(post({ version: "0.2.0", target: "shell", action: "restart" }));

    expect(res.status).toBe(409);
    expect(restart).not.toHaveBeenCalled();
  });
});
