/**
 * `libi.get_job_status` / `libi.cancel_job` MCP tool tests.
 *
 * After Task 6 the MCP child no longer holds a JobManager — these tools
 * delegate to `@/mcp/jobs-client`, which talks to the Next.js server over
 * HTTP. Tests mock that boundary directly; nothing in this file imports
 * `lib/jobs/manager` or `lib/jobs/runners/*`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/mcp/jobs-client", () => ({
  getJobStatusFromServer: vi.fn(),
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
  cancelJobOnServer,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import { cancelJob, getJobStatus } from "@/mcp/tools/job-tools";

const getStatusMock = vi.mocked(getJobStatusFromServer);
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
