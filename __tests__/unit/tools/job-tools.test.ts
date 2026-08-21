/**
 * `libi.get_job_status` / `libi.list_jobs` / `libi.cancel_job` MCP tool tests.
 *
 * After Task 6 the MCP child no longer holds a JobManager — these tools
 * delegate to `@/mcp/jobs-client`, which talks to the Next.js server over
 * HTTP. Tests mock that boundary directly; nothing in this file imports
 * `lib/jobs/manager` or `lib/jobs/runners/*`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/mcp/jobs-client", () => ({
  getJobStatusFromServer: vi.fn(),
  listJobsFromServer: vi.fn(),
  cancelJobOnServer: vi.fn(),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {
    hint: string;
    constructor(message: string, hint: string) {
      super(message);
      this.name = "LibiServerUnavailableError";
      this.hint = hint;
    }
  },
}));

import {
  getJobStatusFromServer,
  listJobsFromServer,
  cancelJobOnServer,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import { cancelJob, getJobStatus, listJobs } from "@/mcp/tools/job-tools";

const getStatusMock = vi.mocked(getJobStatusFromServer);
const listJobsMock = vi.mocked(listJobsFromServer);
const cancelMock = vi.mocked(cancelJobOnServer);

describe("libi.get_job_status", () => {
  beforeEach(() => {
    getStatusMock.mockReset();
    cancelMock.mockReset();
  });

  it("returns the snapshot on success", async () => {
    const snapshot = {
      id: "job-1",
      kind: "tracking",
      status: "running" as const,
      pieceId: null,
      fileId: null,
      progressDone: 5,
      progressTotal: 10,
      progressUnit: "frames",
      etaMs: null,
      msPerUnit: null,
      msSinceProgress: null,
      error: null,
      resultJson: null,
      startedAt: null,
      completedAt: null,
      lastProgressAt: null,
    };
    getStatusMock.mockResolvedValueOnce(snapshot);

    const out = await getJobStatus({ jobId: "job-1" });
    expect(out.success).toBe(true);
    expect((out.data as { id: string }).id).toBe("job-1");
    expect(getStatusMock).toHaveBeenCalledWith("job-1");
  });

  it("returns success:false with not-found error when server 404s", async () => {
    getStatusMock.mockRejectedValueOnce(new Error("job not found: missing"));
    const out = await getJobStatus({ jobId: "missing" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found/i);
  });

  it("returns libi_server_unavailable when server is down", async () => {
    getStatusMock.mockRejectedValueOnce(
      new LibiServerUnavailableError(
        "failed to reach libi server",
        "libi server not running. Start it with `npx @nagellabs/libi`.",
      ),
    );
    const out = await getJobStatus({ jobId: "job-1" });
    expect(out.success).toBe(false);
    expect(out.error).toBe("libi_server_unavailable");
    expect((out.data as { hint: string }).hint).toMatch(/libi server/i);
  });
});

describe("libi.cancel_job", () => {
  beforeEach(() => {
    getStatusMock.mockReset();
    cancelMock.mockReset();
  });

  it("forwards to cancelJobOnServer and returns success", async () => {
    cancelMock.mockResolvedValueOnce(undefined);
    const out = await cancelJob({ jobId: "job-1" });
    expect(out.success).toBe(true);
    expect((out.data as { jobId: string }).jobId).toBe("job-1");
    expect(cancelMock).toHaveBeenCalledWith("job-1");
  });

  it("returns success:false with not-found when server 404s", async () => {
    cancelMock.mockRejectedValueOnce(new Error("job not found: missing"));
    const out = await cancelJob({ jobId: "missing" });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found/i);
  });

  it("returns libi_server_unavailable when server is down", async () => {
    cancelMock.mockRejectedValueOnce(
      new LibiServerUnavailableError(
        "failed to reach libi server",
        "libi server not running. Start it with `npx @nagellabs/libi`.",
      ),
    );
    const out = await cancelJob({ jobId: "job-1" });
    expect(out.success).toBe(false);
    expect(out.error).toBe("libi_server_unavailable");
    expect((out.data as { hint: string }).hint).toMatch(/libi server/i);
  });
});

describe("libi.list_jobs", () => {
  beforeEach(() => {
    listJobsMock.mockReset();
  });

  type Row = Parameters<typeof listJobsMock.mockResolvedValueOnce>[0] extends
    | Promise<infer T>
    | infer T
    ? T
    : never;

  function row(over: Record<string, unknown> = {}): Row[number] {
    return {
      id: "job-1",
      kind: "music_model_download",
      status: "running",
      pieceId: null,
      fileId: null,
      progressDone: 4821,
      progressTotal: 8276,
      progressUnit: "MB",
      etaMs: null,
      msPerUnit: 200,
      msSinceProgress: 12_000,
      error: null,
      resultJson: null,
      startedAt: null,
      completedAt: null,
      lastProgressAt: null,
      ...over,
    } as Row[number];
  }

  it("shapes a running download into something answerable", async () => {
    listJobsMock.mockResolvedValueOnce([row()]);
    const out = await listJobs({ status: "running" });
    expect(out.success).toBe(true);
    const jobs = (out.data as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe("job-1");
    expect(jobs[0].kind).toBe("music_model_download");
    expect(jobs[0].progress).toBe("4821/8276 MB");
    expect(jobs[0].percent).toBe(58);
    expect(jobs[0].msSinceProgress).toBe(12_000);
  });

  it("passes filters through, defaulting the limit", async () => {
    listJobsMock.mockResolvedValueOnce([]);
    await listJobs({ status: "running", kind: "export_render" });
    expect(listJobsMock).toHaveBeenCalledWith({
      status: "running",
      kind: "export_render",
      limit: 20,
    });
  });

  it("reports an empty list rather than failing", async () => {
    listJobsMock.mockResolvedValueOnce([]);
    const out = await listJobs({});
    expect(out.success).toBe(true);
    expect((out.data as { count: number }).count).toBe(0);
  });

  it("omits progress when the runner never reported a total", async () => {
    listJobsMock.mockResolvedValueOnce([
      row({ progressDone: 0, progressTotal: 0 }),
    ]);
    const out = await listJobs({});
    const jobs = (out.data as { jobs: Array<Record<string, unknown>> }).jobs;
    // Deliberately null, not "0/0" or 0% — an unstarted job must not read as
    // one that has made no progress.
    expect(jobs[0].progress).toBeNull();
    expect(jobs[0].percent).toBeNull();
  });

  // The snapshot type says Date, but these arrive over HTTP as ISO strings and
  // the client casts the response — so `.valueOf()` arithmetic would yield NaN.
  it("computes elapsedMs from ISO strings as they arrive over HTTP", async () => {
    listJobsMock.mockResolvedValueOnce([
      row({
        startedAt: "2026-08-17T06:52:40.307Z" as unknown as Date,
        completedAt: "2026-08-17T07:19:13.067Z" as unknown as Date,
        status: "completed",
      }),
    ]);
    const out = await listJobs({});
    const jobs = (out.data as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(jobs[0].elapsedMs).toBe(1_592_760); // 26m 32s, the real download
  });

  it("computes elapsedMs from Date objects too", async () => {
    listJobsMock.mockResolvedValueOnce([
      row({
        startedAt: new Date("2026-08-17T06:52:40.307Z"),
        completedAt: new Date("2026-08-17T07:19:13.067Z"),
        status: "completed",
      }),
    ]);
    const out = await listJobs({});
    const jobs = (out.data as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(jobs[0].elapsedMs).toBe(1_592_760);
  });

  it("leaves elapsedMs null for a job that never started", async () => {
    listJobsMock.mockResolvedValueOnce([row({ startedAt: null, status: "queued" })]);
    const out = await listJobs({});
    const jobs = (out.data as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(jobs[0].elapsedMs).toBeNull();
  });

  it("returns libi_server_unavailable when the server is down", async () => {
    listJobsMock.mockRejectedValueOnce(
      new LibiServerUnavailableError(
        "failed to reach libi server",
        "libi server not running. Start it with `npx @nagellabs/libi`.",
      ),
    );
    const out = await listJobs({});
    expect(out.success).toBe(false);
    expect(out.error).toBe("libi_server_unavailable");
  });
});
