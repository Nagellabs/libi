/**
 * app/api/agents/[agentId]/install/route.ts
 *
 * POST enqueues the `agent_install` job JobManager runs as `kind:
 * "agent_install"` (lib/jobs/runners/agent-install.ts). This route never
 * decides install-vs-dedupe itself — it surfaces whatever `enqueue()`
 * returns, same as `POST /api/jobs`. GET/DELETE resolve "the job" by
 * reading the newest `agent_install` row whose stored params.agentId
 * matches, mirroring `latestInstallJob()` in app/api/runtime/update/route.ts
 * (kind-scoped read, no dedicated agentId column).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const manager = {
  enqueue: vi.fn(),
  runToCompletion: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
};
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => manager }));

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let installedAgents = new Set(["claude-code"]);
vi.mock("@/lib/agents/setup/registry", () => ({
  getAgentSetup: (agentId: string) => {
    if (agentId === "claude-code" && installedAgents.has("claude-code")) {
      return { id: "claude-code", name: "Claude Code", install: { command: "npm i -g x" } };
    }
    if (agentId === "codex") {
      // Real registry entry: install is null — libi ships Codex.
      return { id: "codex", name: "Codex", install: null };
    }
    return null; // unknown id, e.g. "terminal"
  },
}));

interface FakeJobRow {
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "cancel-requested";
  pieceId: string | null;
  fileId: string | null;
  paramsHash: string;
  paramsJson: string;
  progressDone: number;
  progressTotal: number;
  progressUnit: string;
  msPerUnit: number | null;
  partialPath: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lastProgressAt: Date | null;
}

function fakeRow(overrides: Partial<FakeJobRow> & { id: string; agentId: string }): FakeJobRow {
  const { agentId, ...rest } = overrides;
  return {
    kind: "agent_install",
    status: "queued",
    pieceId: null,
    fileId: null,
    paramsHash: "hash",
    paramsJson: JSON.stringify({ agentId }),
    progressDone: 0,
    progressTotal: 0,
    progressUnit: "MB",
    msPerUnit: null,
    partialPath: null,
    resultJson: null,
    error: null,
    createdAt: new Date(0),
    startedAt: null,
    completedAt: null,
    lastProgressAt: null,
    ...rest,
  };
}

// Rows the route's DB read should see, newest-first — the route's own
// query does the ordering in SQL (`orderBy(desc(createdAt))`), so the mock
// hands back whatever order the test sets, exactly like the real DB would
// after that ORDER BY.
let dbRows: FakeJobRow[] = [];
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              all: () => dbRows,
            }),
          }),
        }),
      }),
    }),
  }),
}));

function req(method: string) {
  return new Request(`http://x/api/agents/x/install`, { method });
}

function ctx(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears call history but NOT a queued `mockResolvedValueOnce`
  // chain — a test that queues two values but the route only consumes one (the
  // pre-fix behavior this suite is guarding against) would otherwise leak its
  // second value into the next test's first `enqueue()` call.
  manager.enqueue.mockReset();
  installedAgents = new Set(["claude-code"]);
  dbRows = [];
});

describe("POST /api/agents/[agentId]/install", () => {
  it("enqueues agent_install and returns { jobId, status } from a fresh enqueue", async () => {
    manager.enqueue.mockResolvedValue({ status: "new", jobId: "job-1", clientKey: "k1" });
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await POST(req("POST"), ctx("claude-code"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ jobId: "job-1", status: "new" });
    expect(manager.enqueue).toHaveBeenCalledWith("agent_install", { agentId: "claude-code" });
    // "new" schedules execution — this is the only trigger; nothing else runs the job.
    expect(manager.runToCompletion).toHaveBeenCalledWith("job-1");
  });

  it("a second POST while one is running attaches to the SAME jobId and does not start a new run", async () => {
    manager.enqueue.mockResolvedValueOnce({ status: "new", jobId: "job-1", clientKey: "k1" });
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res1 = await POST(req("POST"), ctx("claude-code"));
    const body1 = await res1.json();
    expect(body1).toEqual({ jobId: "job-1", status: "new" });

    manager.enqueue.mockResolvedValueOnce({
      status: "attached_running",
      jobId: "job-1",
      clientKey: "k1",
      existingJob: { jobId: "job-1", pieceId: null, startedAt: new Date(0).toISOString() },
    });
    const res2 = await POST(req("POST"), ctx("claude-code"));
    const body2 = await res2.json();

    expect(body2).toEqual({ jobId: "job-1", status: "attached_running" });
    expect(body2.jobId).toBe(body1.jobId);
    // Scheduled once per POST call that reports new/attached_running — but
    // both calls resolve to job-1, never a second distinct job.
    expect(manager.runToCompletion).toHaveBeenCalledTimes(2);
    expect(manager.runToCompletion).toHaveBeenNthCalledWith(1, "job-1");
    expect(manager.runToCompletion).toHaveBeenNthCalledWith(2, "job-1");
  });

  it("returns 400 (never 500) when asked to install codex — libi ships it, install is null", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await POST(req("POST"), ctx("codex"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(manager.enqueue).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown/unregistered agent id", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await POST(req("POST"), ctx("terminal"));

    expect(res.status).toBe(400);
    expect(manager.enqueue).not.toHaveBeenCalled();
  });

  it("starts a fresh job when Install is clicked after a failure", async () => {
    // The dead end this feature exists to remove, reproduced inside its own fix:
    // without this, the card shows "failed" forever and Retry is decorative.
    manager.enqueue
      .mockResolvedValueOnce({
        status: "matching_completed",
        existingJob: {
          jobId: "job-old",
          pieceId: null,
          completedAt: new Date(0).toISOString(),
          status: "failed",
        },
      })
      .mockResolvedValueOnce({ status: "new", jobId: "job-new", clientKey: "k2", forced: true });
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await POST(req("POST"), ctx("claude-code"));
    const body = await res.json();

    expect(body).toEqual({ jobId: "job-new", status: "new" });
    expect(manager.enqueue).toHaveBeenCalledTimes(2);
    expect(manager.enqueue).toHaveBeenNthCalledWith(2, "agent_install", { agentId: "claude-code" }, { forceNew: true });
    expect(manager.runToCompletion).toHaveBeenCalledWith("job-new");
  });

  it("starts a fresh job when Install is clicked after a cancellation", async () => {
    // Same shape as the failed case — cancelling and changing your mind must work.
    manager.enqueue
      .mockResolvedValueOnce({
        status: "matching_completed",
        existingJob: {
          jobId: "job-old",
          pieceId: null,
          completedAt: new Date(0).toISOString(),
          status: "cancelled",
        },
      })
      .mockResolvedValueOnce({ status: "new", jobId: "job-new", clientKey: "k2", forced: true });
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await POST(req("POST"), ctx("claude-code"));
    const body = await res.json();

    expect(body).toEqual({ jobId: "job-new", status: "new" });
    expect(manager.enqueue).toHaveBeenCalledTimes(2);
    expect(manager.enqueue).toHaveBeenNthCalledWith(2, "agent_install", { agentId: "claude-code" }, { forceNew: true });
    expect(manager.runToCompletion).toHaveBeenCalledWith("job-new");
  });

  it("does NOT re-run a completed install", async () => {
    // Clicking twice on a finished install must not spend another 250 MB.
    manager.enqueue.mockResolvedValueOnce({
      status: "matching_completed",
      existingJob: {
        jobId: "job-done",
        pieceId: null,
        completedAt: new Date(0).toISOString(),
        status: "completed",
      },
    });
    const { POST } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await POST(req("POST"), ctx("claude-code"));
    const body = await res.json();

    expect(body).toEqual({ jobId: "job-done", status: "matching_completed" });
    expect(manager.enqueue).toHaveBeenCalledTimes(1);
    expect(manager.runToCompletion).not.toHaveBeenCalled();
  });
});

describe("GET /api/agents/[agentId]/install", () => {
  it("returns { job: null } when no agent_install job exists for this agent", async () => {
    dbRows = [];
    const { GET } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await GET(req("GET"), ctx("claude-code"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: null });
  });

  it("returns the newest agent_install job snapshot for this agent, ignoring other agents' rows", async () => {
    // The mock array is pre-sorted newest-first (matching the real
    // `orderBy(desc(createdAt))`), so the FIRST element is the one that
    // should win — name it accordingly, not the reverse.
    dbRows = [
      fakeRow({ id: "job-new", agentId: "claude-code", status: "completed" }),
      fakeRow({ id: "job-other-agent", agentId: "some-other-agent", status: "running" }),
      fakeRow({ id: "job-old", agentId: "claude-code", status: "running" }),
    ];
    const { GET } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await GET(req("GET"), ctx("claude-code"));
    const body = await res.json();

    expect(body.job).not.toBeNull();
    expect(body.job.id).toBe("job-new");
    expect(body.job.status).toBe("completed");
  });
});

describe("DELETE /api/agents/[agentId]/install", () => {
  it("cancels the newest agent_install job for this agent (delegates to JobManager.cancel)", async () => {
    dbRows = [fakeRow({ id: "job-1", agentId: "claude-code", status: "running" })];
    const { DELETE } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await DELETE(req("DELETE"), ctx("claude-code"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(manager.cancel).toHaveBeenCalledWith("job-1");
  });

  it("returns 404 when there is no install job to cancel", async () => {
    dbRows = [];
    const { DELETE } = await import("@/app/api/agents/[agentId]/install/route");

    const res = await DELETE(req("DELETE"), ctx("claude-code"));

    expect(res.status).toBe(404);
    expect(manager.cancel).not.toHaveBeenCalled();
  });
});
